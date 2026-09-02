import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { HttpSidecarToolSource, McpHttpToolSource } from "../src/core/tool-sources.ts";

const servers: ReturnType<typeof createServer>[] = [];
const testContext = {} as ExtensionContext;

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("external tool sources", () => {
	it("discovers and executes a Mino HTTP sidecar tool", async () => {
		const url = await startServer(async (request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/tools") {
				response.end(JSON.stringify([{ name: "weather", description: "Get weather", schema: { type: "object" } }]));
				return;
			}
			if (request.url === "/execute") {
				let body = "";
				for await (const chunk of request) body += chunk;
				response.end(JSON.stringify({ result: `called ${JSON.parse(body).tool}` }));
				return;
			}
			response.statusCode = 404;
			response.end();
		});

		const [tool] = await new HttpSidecarToolSource({ name: "weather", url }).load();
		const result = await tool.definition.execute("call-1", {}, undefined, undefined, testContext);
		expect(tool.sourceInfo.source).toBe("sidecar:weather");
		expect(result.content).toEqual([{ type: "text", text: "[UNTRUSTED EXTERNAL CONTENT]\ncalled weather" }]);
	});

	it("discovers and executes an MCP HTTP tool", async () => {
		const url = await startServer(async (request, response) => {
			response.setHeader("content-type", "application/json");
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body) as { method: string };
			const result =
				message.method === "initialize"
					? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } }
					: message.method === "tools/list"
						? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: "hello" }] };
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
		});

		const [tool] = await new McpHttpToolSource({ name: "test", url }).load();
		const result = await tool.definition.execute("call-1", {}, undefined, undefined, testContext);
		expect(tool.sourceInfo.source).toBe("mcp:test");
		expect(result.content).toEqual([
			{ type: "text", text: '[UNTRUSTED EXTERNAL CONTENT]\n[{"type":"text","text":"hello"}]' },
		]);
	});
});
