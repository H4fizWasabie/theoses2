import type { Context, ProviderHeaders } from "theoses-ai";
import { type AssistantMessage, EventStream, getModel } from "theoses-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createBudgetedAgent } from "../src/core/background-agent.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

// Same scripted-model idiom as explorer.test.ts / researcher.test.ts.
class MockAssistantStream extends EventStream<
	{ type: "start" | "done"; partial?: AssistantMessage; reason?: string; message?: AssistantMessage },
	AssistantMessage
> {
	constructor() {
		super(
			(event) => event.type === "done",
			(event) => event.message as AssistantMessage,
		);
	}
}

function assistant(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1000,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** A script step that streams nothing until the request is aborted, then ends as an aborted reply. */
const HANG = "hang";

function fakeRuntime(...script: Array<AssistantMessage | typeof HANG>): {
	runtime: ModelRuntime;
	callCount: () => number;
	/** The tool names each request offered the model, in call order. */
	toolsOffered: string[][];
} {
	let call = 0;
	const toolsOffered: string[][] = [];
	const runtime = {
		getModel: () => getModel("anthropic", "claude-sonnet-4-5")!,
		streamSimple: (_model: unknown, context: Context, streamOptions: { signal?: AbortSignal }) => {
			toolsOffered.push((context.tools ?? []).map((tool) => tool.name));
			const step = script[Math.min(call++, script.length - 1)];
			const stream = new MockAssistantStream();
			if (step === HANG) {
				const aborted = assistant("half a thought", { stopReason: "aborted" });
				stream.push({ type: "start", partial: aborted });
				streamOptions.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "done", reason: "aborted", message: aborted }),
					{ once: true },
				);
				return stream;
			}
			queueMicrotask(() => {
				stream.push({ type: "start", partial: step });
				stream.push({ type: "done", reason: step.stopReason, message: step });
			});
			return stream;
		},
	} as unknown as ModelRuntime;
	return { runtime, callCount: () => call, toolsOffered };
}

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("createBudgetedAgent", () => {
	it("returns the answer with turn/token stats from a completed prompt", async () => {
		const { runtime } = fakeRuntime(assistant("the answer"));
		const handle = createBudgetedAgent({
			systemPrompt: "test",
			model,
			tools: [],
			modelRuntime: runtime,
			maxTurns: 5,
			maxInputTokens: 100_000,
		});

		const result = await handle.promptToAnswer("question", { finalizePrompt: "write it up" });

		expect(result).toEqual({
			status: "complete",
			text: "the answer",
			stats: {
				turns: 1,
				inputTokens: 1000,
				outputTokens: 50,
				cost: 0,
				usage: assistant("").usage,
				stoppedByBudget: false,
			},
			finalized: false,
			stoppedBy: [],
			aborted: false,
		});
	});

	it("counts cached input toward inputTokens and the budget (#390)", async () => {
		const cached = assistant("still working", {
			usage: {
				input: 18,
				output: 50,
				cacheRead: 900,
				cacheWrite: 100,
				totalTokens: 1068,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const { runtime } = fakeRuntime(cached);
		const handle = createBudgetedAgent({
			systemPrompt: "test",
			model,
			tools: [],
			modelRuntime: runtime,
			maxTurns: 100,
			maxInputTokens: 1000,
		});

		const result = await handle.promptToAnswer("question", {
			finalizePrompt: "write it up",
			isAnswer: (_text, stats) => !stats.stoppedByBudget,
		});

		expect(result.stoppedBy).toEqual(["1K input-token cap"]);
		expect(result.stats.inputTokens).toBe(1018 * 2);
	});

	it("counts the finalize turn against the same budget as the first prompt", async () => {
		const cached = assistant("second", {
			usage: {
				input: 100,
				output: 50,
				cacheRead: 900,
				cacheWrite: 0,
				totalTokens: 1050,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
			},
		});
		const { runtime } = fakeRuntime(assistant("first"), cached);
		const handle = createBudgetedAgent({
			systemPrompt: "test",
			model,
			tools: [],
			modelRuntime: runtime,
			maxTurns: 5,
			maxInputTokens: 100_000,
		});

		const result = await handle.promptToAnswer("first question", {
			finalizePrompt: "write it up",
			isAnswer: (text) => text === "second",
		});

		expect(result.text).toBe("second");
		expect(result.stats).toEqual({
			turns: 2,
			inputTokens: 2000,
			outputTokens: 100,
			cost: 0.31,
			usage: {
				input: 1100,
				output: 100,
				cacheRead: 900,
				cacheWrite: 0,
				totalTokens: 2100,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
			},
			stoppedByBudget: false,
		});
	});

	describe("promptToAnswer", () => {
		const isReport = (text: string) => text.startsWith("Summary");
		function handleFor(
			runtime: ModelRuntime,
			extra: {
				maxTurns?: number;
				signal?: AbortSignal;
				tools?: Parameters<typeof createBudgetedAgent>[0]["tools"];
			} = {},
		) {
			return createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: extra.tools ?? [],
				modelRuntime: runtime,
				maxTurns: extra.maxTurns ?? 5,
				maxInputTokens: 100_000,
				signal: extra.signal,
			});
		}

		it("does not finalize when the first prompt already answered", async () => {
			const { runtime, callCount } = fakeRuntime(assistant("Summary: done"));
			const handle = handleFor(runtime);

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.finalized).toBe(false);
			expect(result.text).toBe("Summary: done");
			expect(result.stoppedBy).toEqual([]);
			expect(callCount()).toBe(1);
		});

		it("runs one tool-free finalize turn on the same budget when the first prompt did not answer", async () => {
			const { runtime, callCount, toolsOffered } = fakeRuntime(
				assistant("let me look further"),
				assistant("Summary: final"),
			);
			const handle = handleFor(runtime, { tools: [noopTool] });

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.finalized).toBe(true);
			expect(result.text).toBe("Summary: final");
			expect(result.stats).toMatchObject({
				turns: 2,
				inputTokens: 2000,
				outputTokens: 100,
				cost: 0,
				stoppedByBudget: false,
			});
			expect(toolsOffered).toEqual([["noop"], []]);
			expect(callCount()).toBe(2);
		});

		it("finalizes after a cap and reports which limit the first prompt hit", async () => {
			const { runtime } = fakeRuntime(assistant("still working"), assistant("Summary: partial"));
			const handle = handleFor(runtime, { maxTurns: 1 });

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.finalized).toBe(true);
			expect(result.stoppedBy).toEqual(["1-turn cap"]);
			expect(result.text).toBe("Summary: partial");
		});

		it("passes the stats so far to isAnswer", async () => {
			const { runtime, callCount } = fakeRuntime(assistant("still working"));
			const handle = handleFor(runtime, { maxTurns: 1 });

			const result = await handle.promptToAnswer("q", {
				finalizePrompt: "write it up",
				isAnswer: (_text, stats) => !stats.stoppedByBudget,
			});

			expect(result.finalized).toBe(true);
			expect(callCount()).toBe(2);
		});

		const noopTool = {
			name: "noop",
			label: "noop",
			description: "does nothing",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
		} as Parameters<typeof createBudgetedAgent>[0]["tools"][number];
		const narrationWithToolCall = (turn: number) =>
			assistant("", {
				content: [
					{ type: "text", text: "Let me look again." },
					{ type: "toolCall", id: `c${turn}`, name: "noop", arguments: { path: "a.txt" } },
				],
				stopReason: "toolUse",
			});

		it("reports complete for an answer the first prompt wrote on its own", async () => {
			const { runtime } = fakeRuntime(assistant("Summary: done"));

			const result = await handleFor(runtime).promptToAnswer("q", {
				finalizePrompt: "write it up",
				isAnswer: isReport,
			});

			expect(result.status).toBe("complete");
		});

		it("does not take the narration beside a capped run's last tool call for an answer", async () => {
			const { runtime } = fakeRuntime(narrationWithToolCall(1), assistant("Summary: written up"));
			const handle = handleFor(runtime, { maxTurns: 1, tools: [noopTool] });

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up" });

			expect(result.finalized).toBe(true);
			expect(result.status).toBe("partial");
			expect(result.text).toBe("Summary: written up");
		});

		it("reports none, with the last text as notes, when even the finalize turn writes no answer", async () => {
			const { runtime } = fakeRuntime(assistant("let me look"), assistant("still looking"));

			const result = await handleFor(runtime).promptToAnswer("q", {
				finalizePrompt: "write it up",
				isAnswer: isReport,
			});

			expect(result.status).toBe("none");
			expect(result.text).toBe("still looking");
		});

		it("caps the answer's lines, reports tool calls as status, and sums the cost", async () => {
			const answer = assistant("Summary\nline 2\nline 3", {
				usage: {
					input: 1000,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1050,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			});
			const { runtime } = fakeRuntime(narrationWithToolCall(1), answer);
			const statuses: string[] = [];
			const handle = createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: [noopTool],
				modelRuntime: runtime,
				maxTurns: 5,
				maxInputTokens: 100_000,
				capLines: 2,
				onStatus: (status) => statuses.push(status),
			});

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up" });

			expect(result.text).toBe("Summary\nline 2\n[truncated by harness: exceeded 2 lines]");
			expect(statuses).toEqual(['noop: {"path":"a.txt"}']);
			expect(result.stats.cost).toBe(0.25);
		});

		it("cuts a hung turn off at the time limit and still gets a write-up from the finalize turn", async () => {
			const { runtime, callCount } = fakeRuntime(HANG, assistant("Summary: what I had"));
			const handle = createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: [],
				modelRuntime: runtime,
				maxTurns: 5,
				maxInputTokens: 100_000,
				maxWallMs: 20,
			});

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.status).toBe("partial");
			expect(result.text).toBe("Summary: what I had");
			expect(result.stoppedBy).toEqual(["0.02-second time limit"]);
			expect(result.aborted).toBe(false);
			expect(callCount()).toBe(2);
		});

		it("gives up with no answer when the finalize turn after a time limit hangs past its grace", async () => {
			const { runtime, callCount } = fakeRuntime(HANG, HANG);
			const handle = createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: [],
				modelRuntime: runtime,
				maxTurns: 5,
				maxInputTokens: 100_000,
				maxWallMs: 20,
				finalizeGraceMs: 20,
			});

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up" });

			expect(result.status).toBe("none");
			expect(result.text).toBe("half a thought");
			expect(result.stoppedBy).toEqual(["0.02-second time limit"]);
			expect(callCount()).toBe(2);
		});

		it("reports a stop during the finalize turn after a time limit as stopped, with the cut-off reply only as notes", async () => {
			const controller = new AbortController();
			const { runtime, callCount } = fakeRuntime(HANG, HANG);
			const handle = createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: [],
				modelRuntime: runtime,
				maxTurns: 5,
				maxInputTokens: 100_000,
				maxWallMs: 20,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 60);

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up" });

			expect(callCount()).toBe(2);
			expect(result.aborted).toBe(true);
			expect(result.status).toBe("none");
			expect(result.text).toBe("half a thought");
			expect(result.stoppedBy).toEqual(["0.02-second time limit"]);
			expect(result.stats.stoppedByBudget).toBe(true);
		});

		it("skips the finalize turn once the signal has aborted", async () => {
			const controller = new AbortController();
			const { runtime, callCount } = fakeRuntime(assistant("working"), assistant("Summary: never"));
			const handle = handleFor(runtime, { signal: controller.signal });
			controller.abort();

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.finalized).toBe(false);
			expect(result.aborted).toBe(true);
			expect(callCount()).toBeLessThanOrEqual(1);
		});

		it("stops a running turn when the caller's signal aborts, with no finalize turn and no cap blamed", async () => {
			const controller = new AbortController();
			const { runtime, callCount } = fakeRuntime(HANG, assistant("Summary: never"));
			const handle = createBudgetedAgent({
				systemPrompt: "test",
				model,
				tools: [],
				modelRuntime: runtime,
				maxTurns: 5,
				maxInputTokens: 100_000,
				maxWallMs: 60_000,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 10);

			const result = await handle.promptToAnswer("q", { finalizePrompt: "write it up", isAnswer: isReport });

			expect(result.aborted).toBe(true);
			expect(result.finalized).toBe(false);
			expect(result.stoppedBy).toEqual([]);
			expect(callCount()).toBe(1);
		});
	});

	it("passes onPayload/onResponse through to the Agent, and wires transformHeaders into streamSimple's options", async () => {
		let seenStreamOptions: { onPayload?: unknown; onResponse?: unknown; transformHeaders?: unknown } | undefined;
		const onPayload = vi.fn(async (payload: unknown) => payload);
		const onResponse = vi.fn(async () => {});
		const transformHeaders = vi.fn(async (headers: ProviderHeaders | undefined) => headers ?? {});
		const runtime = {
			getModel: () => model,
			streamSimple: (_model: unknown, _context: unknown, streamOptions: Record<string, unknown>) => {
				seenStreamOptions = streamOptions;
				const stream = new MockAssistantStream();
				const message = assistant("done");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		} as unknown as ModelRuntime;

		const handle = createBudgetedAgent({
			systemPrompt: "test",
			model,
			tools: [],
			modelRuntime: runtime,
			maxTurns: 5,
			maxInputTokens: 100_000,
			providerHooks: { onPayload, onResponse, transformHeaders },
		});
		await handle.promptToAnswer("question", { finalizePrompt: "write it up" });

		// onPayload/onResponse are Agent-level hooks (invoked by the agent loop around the stream
		// call, not by this fake streamSimple) - this module's job is only to pass them through to
		// the Agent constructor unchanged, which the type system already enforces at the call site.
		// transformHeaders is different: it's this module's own job to inject it into streamSimple's
		// per-call options (AgentLoopConfig doesn't carry it), so that part is checked directly.
		expect(typeof seenStreamOptions?.transformHeaders).toBe("function");
		const resolvedHeaders = await (seenStreamOptions?.transformHeaders as (h: Record<string, string>) => unknown)({
			"x-test": "1",
		});
		expect(resolvedHeaders).toEqual({ "x-test": "1" });
		expect(transformHeaders).toHaveBeenCalledWith({ "x-test": "1" }, model);
	});
});
