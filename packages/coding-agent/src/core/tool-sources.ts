import type { AgentToolResult, AgentToolUpdateCallback } from "theoses-agent-core";
import type { TSchema } from "typebox";
import { VERSION } from "../config.ts";
import type { RegisteredTool, ToolDefinition } from "./extensions/types.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ToolSource {
	readonly name: string;
	load(signal?: AbortSignal): Promise<RegisteredTool[]>;
}

interface DiscoveredTool {
	name: string;
	description?: string;
	schema?: unknown;
	inputSchema?: unknown;
}

function parseSchema(value: unknown, source: string, toolName: string): TSchema {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${source} tool ${toolName} returned an invalid input schema`);
	}
	return value as TSchema;
}

function parseToolList(value: unknown, source: string): DiscoveredTool[] {
	const tools = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "tools" in value
			? (value as { tools?: unknown }).tools
			: undefined;
	if (!Array.isArray(tools)) throw new Error(`${source} returned an invalid tool catalog`);

	return tools.map((tool) => {
		if (typeof tool !== "object" || tool === null) throw new Error(`${source} returned an invalid tool entry`);
		const entry = tool as { name?: unknown; description?: unknown; schema?: unknown; inputSchema?: unknown };
		if (typeof entry.name !== "string" || !entry.name) throw new Error(`${source} returned a tool without a name`);
		return {
			name: entry.name,
			description: typeof entry.description === "string" ? entry.description : undefined,
			schema: entry.schema,
			inputSchema: entry.inputSchema,
		};
	});
}

function responseText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function externalResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function createExternalTool(
	tool: DiscoveredTool,
	sourceInfo: SourceInfo,
	execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<string>,
): RegisteredTool {
	const definition: ToolDefinition<TSchema, unknown> = {
		name: tool.name,
		label: tool.name,
		description: tool.description ?? `External tool ${tool.name}`,
		parameters: parseSchema(tool.inputSchema ?? tool.schema, sourceInfo.source, tool.name),
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		) => externalResult(await execute(tool.name, params, signal)),
	};
	return { definition, sourceInfo };
}

async function readJson(response: Response, source: string): Promise<unknown> {
	if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
	return response.json();
}

export interface HttpSidecarToolSourceOptions {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export class HttpSidecarToolSource implements ToolSource {
	readonly name: string;
	private readonly url: string;
	private readonly headers: Record<string, string>;

	constructor(options: HttpSidecarToolSourceOptions) {
		this.name = options.name;
		this.url = options.url.replace(/\/$/, "");
		this.headers = options.headers ?? {};
	}

	async load(signal?: AbortSignal): Promise<RegisteredTool[]> {
		const response = await fetch(`${this.url}/tools`, { headers: this.headers, signal });
		const catalog = parseToolList(await readJson(response, `Sidecar ${this.name}`), `Sidecar ${this.name}`);
		const sourceInfo = createSyntheticSourceInfo(`<sidecar:${this.name}>`, { source: `sidecar:${this.name}` });
		return catalog.map((tool) =>
			createExternalTool(tool, sourceInfo, async (toolName, args, executeSignal) => {
				const executeResponse = await fetch(`${this.url}/execute`, {
					method: "POST",
					headers: { "content-type": "application/json", ...this.headers },
					body: JSON.stringify({ tool: toolName, args }),
					signal: executeSignal,
				});
				const result = await readJson(executeResponse, `Sidecar ${this.name}`);
				if (typeof result === "object" && result !== null && "error" in result) {
					throw new Error(String((result as { error?: unknown }).error));
				}
				const output =
					typeof result === "object" && result !== null && "result" in result
						? (result as { result?: unknown }).result
						: result;
				return `[UNTRUSTED EXTERNAL CONTENT]\n${responseText(output)}`;
			}),
		);
	}
}

interface JsonRpcResponse {
	result?: unknown;
	error?: { code?: number; message?: string };
}

function parseJsonRpcResponse(value: unknown, source: string): JsonRpcResponse {
	if (typeof value !== "object" || value === null) throw new Error(`${source} returned an invalid MCP response`);
	const response = value as JsonRpcResponse;
	if (response.error) throw new Error(`${source}: ${response.error.message ?? "request failed"}`);
	return response;
}

export interface McpHttpToolSourceOptions {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export class McpHttpToolSource implements ToolSource {
	readonly name: string;
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private requestId = 0;
	private sessionId?: string;

	constructor(options: McpHttpToolSourceOptions) {
		this.name = options.name;
		this.url = options.url;
		this.headers = options.headers ?? {};
	}

	private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = ++this.requestId;
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"content-type": "application/json",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				...this.headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			signal,
		});
		if (!response.ok) throw new Error(`MCP ${this.name} returned HTTP ${response.status}`);
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionId = sessionId;
		const text = await response.text();
		const jsonText = response.headers.get("content-type")?.includes("text/event-stream")
			? text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.at(-1)
			: text;
		return parseJsonRpcResponse(JSON.parse(jsonText ?? ""), `MCP ${this.name}`).result;
	}

	private async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
		await fetch(this.url, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"content-type": "application/json",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				...this.headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", method, params }),
			signal,
		});
	}

	async load(signal?: AbortSignal): Promise<RegisteredTool[]> {
		await this.request(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pi-coding-agent", version: VERSION },
			},
			signal,
		);
		await this.notify("notifications/initialized", {}, signal);
		const result = await this.request("tools/list", {}, signal);
		const catalog = parseToolList(result, `MCP ${this.name}`);
		const sourceInfo = createSyntheticSourceInfo(`<mcp:${this.name}>`, { source: `mcp:${this.name}` });
		return catalog.map((tool) =>
			createExternalTool(tool, sourceInfo, async (toolName, args, executeSignal) => {
				const call = await this.request("tools/call", { name: toolName, arguments: args }, executeSignal);
				if (typeof call !== "object" || call === null) return responseText(call);
				const content = (call as { content?: unknown }).content;
				return `[UNTRUSTED EXTERNAL CONTENT]\n${responseText(content ?? call)}`;
			}),
		);
	}
}
