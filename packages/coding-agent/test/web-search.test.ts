import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createWebExtractToolDefinition, createWebSearchToolDefinition } from "../src/core/tools/web-search.ts";

/** A fetch stub returning a scripted sequence of responses, counting calls. */
function stubFetch(...responses: (() => Response | Promise<Response>)[]) {
	let call = 0;
	const mock = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]());
	vi.stubGlobal("fetch", mock);
	return mock;
}

function json(body: unknown, status: number, statusText = "Error"): Response {
	return new Response(JSON.stringify(body), { status, statusText });
}

const OK = () => json({ answer: "ok", results: [{ title: "t", url: "u", content: "c" }] }, 200, "OK");

// The web tools ignore onUpdate/ctx, but the runtime calls execute with all five arguments.
const CTX = {} as ExtensionContext;
interface Runnable {
	execute(
		id: string,
		input: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: unknown[] }>;
}
function run(tool: Runnable, input: object, signal?: AbortSignal) {
	return tool.execute("id", input as never, signal, undefined, CTX);
}
function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("tavilyPost error handling", () => {
	it("surfaces Tavily's reason on a 400 and makes exactly one request", async () => {
		const fetchMock = stubFetch(() =>
			json(
				{ detail: { error: "Query cannot consist only of site: operators. Please provide search terms." } },
				400,
				"Bad Request",
			),
		);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		await expect(run(tool, { query: "site:example.com" })).rejects.toThrow(
			/Query cannot consist only of site: operators/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not leak the API key when it appears in the error body", async () => {
		const fetchMock = stubFetch(() => json({ detail: "bad key key-1 rejected" }, 401, "Unauthorized"));
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		await expect(run(tool, { query: "x" })).rejects.toThrow(/bad key \[redacted\] rejected/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back to the second key on a 429", async () => {
		const fetchMock = stubFetch(() => json({ detail: { error: "rate limited" } }, 429, "Too Many Requests"), OK);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		const result = await run(tool, { query: "x" });
		expect(textOf(result)).toContain("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back to the second key on a 5xx", async () => {
		const fetchMock = stubFetch(() => json({ detail: { error: "upstream boom" } }, 503, "Service Unavailable"), OK);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		const result = await run(tool, { query: "x" });
		expect(textOf(result)).toContain("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// 432 is Tavily's documented exhausted-plan status; 433 and 403 are other key/plan-level codes.
	// None is in a hard-coded allow-list, which is the point: only request errors are not retried.
	it.each([432, 433, 403])("falls back to the second key on key-level status %i", async (status) => {
		const fetchMock = stubFetch(() => json({ detail: { error: "plan usage limit reached" } }, status), OK);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		const result = await run(tool, { query: "x" });
		expect(textOf(result)).toContain("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([400, 422])("does not rotate on request error %i and surfaces the reason", async (status) => {
		const fetchMock = stubFetch(() => json({ detail: { error: `bad query ${status}` } }, status));
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		await expect(run(tool, { query: "x" })).rejects.toThrow(new RegExp(`bad query ${status}`));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports the last status and reason when every key fails", async () => {
		const fetchMock = stubFetch(
			() => json({ detail: { error: "boom-1" } }, 500, "Internal Server Error"),
			() => json({ detail: { error: "boom-2" } }, 502, "Bad Gateway"),
		);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		const error = await run(tool, { query: "x" }).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/502/);
		expect((error as Error).message).toMatch(/boom-2/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reports the last status and reason when every key is plan-exhausted", async () => {
		const fetchMock = stubFetch(
			() => json({ detail: { error: "limit-1" } }, 432, "unavailable"),
			() => json({ detail: { error: "limit-2" } }, 432, "unavailable"),
		);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		const error = await run(tool, { query: "x" }).catch((e: Error) => e);
		expect((error as Error).message).toMatch(/432/);
		expect((error as Error).message).toMatch(/limit-2/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not rotate keys after the abort signal fires", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => {
			controller.abort();
			const err = new Error("The operation was aborted.");
			err.name = "AbortError";
			throw err;
		});
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchToolDefinition({ apiKeys: ["key-1", "key-2"] });

		await expect(run(tool, { query: "x" }, controller.signal)).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces the reason and makes one request for web_extract too", async () => {
		const fetchMock = stubFetch(() => json({ detail: { error: "Invalid URL." } }, 400, "Bad Request"));
		const tool = createWebExtractToolDefinition({ apiKeys: ["key-1", "key-2"] });

		await expect(run(tool, { url: "not-a-url" })).rejects.toThrow(/Invalid URL\./);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
