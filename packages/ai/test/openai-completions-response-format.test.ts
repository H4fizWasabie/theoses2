import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";

// Issue #250: structured-output calls (memory consolidation, compaction distillation) must be
// able to request JSON-object mode, and the openai-completions adapter must forward it as
// `response_format: { "type": "json_object" }`. The option is opt-in per call — the parameter
// is NOT emitted when unset, because not every OpenAI-compatible backend accepts it.

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { content: "{}" }, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function testModel() {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-completions" } as const;
}

describe("openai-completions response_format (json_object)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("emits response_format when responseFormat is requested", async () => {
		await streamSimple(
			testModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", responseFormat: { type: "json_object" } },
		).result();

		const params = mockState.lastParams as { response_format?: { type: string } };
		expect(params.response_format).toEqual({ type: "json_object" });
	});

	it("omits response_format when not requested", async () => {
		await streamSimple(
			testModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { response_format?: unknown };
		expect("response_format" in (params as object)).toBe(false);
	});
});
