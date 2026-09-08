import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: undefined as Array<{ choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks ?? []) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

vi.mock("../src/utils/json-parse.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/json-parse.ts")>();
	return { ...actual, parseStreamingJson: vi.fn(actual.parseStreamingJson) };
});

describe("openai-completions large streaming tool-call arguments", () => {
	beforeEach(() => {
		mockState.chunks = undefined;
		vi.clearAllMocks();
	});

	it("throttles re-parsing of a large accumulated tool-call argument instead of re-parsing on every delta", async () => {
		const { parseStreamingJson } = await import("../src/utils/json-parse.ts");

		// Simulate a large `write` tool call (e.g. a generated HTML file) streamed as
		// thousands of tiny per-token deltas, which is how providers like OpenRouter
		// stream tool-call arguments in practice.
		const path = '{"path":"resume-draft.html","content":"';
		const body = "x".repeat(50_000);
		const closing = '"}';
		const fullArgs = path + body + closing;

		const deltaChunkSize = 8;
		const deltas: string[] = [];
		for (let i = 0; i < fullArgs.length; i += deltaChunkSize) {
			deltas.push(fullArgs.slice(i, i + deltaChunkSize));
		}

		mockState.chunks = deltas.map((delta, i) => ({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								...(i === 0 ? { id: "call_1", type: "function", function: { name: "write", arguments: delta } } : { function: { arguments: delta } }),
							},
						],
					},
					finish_reason: i === deltas.length - 1 ? "tool_calls" : null,
				},
			],
		}));

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tool: Tool = {
			name: "write",
			description: "Write a file",
			parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } as never,
		};

		const response = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Write the file", timestamp: Date.now() }], tools: [tool] },
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("toolUse");
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") throw new Error("Expected toolCall content");
		// Final parsed arguments must be complete and correct regardless of throttling.
		expect(toolCall.arguments).toEqual({ path: "resume-draft.html", content: body });

		// ~6300 deltas were streamed; without throttling this would call parseStreamingJson
		// once per delta (re-scanning the whole accumulated buffer each time -> O(n^2)).
		// With throttling it should only fire a small, roughly-bounded number of times.
		expect(deltas.length).toBeGreaterThan(1000);
		expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(50);
	});
});
