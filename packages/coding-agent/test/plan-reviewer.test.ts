import type { Context } from "theoses-ai";
import { type AssistantMessage, EventStream } from "theoses-ai/compat";
import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { MAX_TURNS, reviewOnce, reviewPlan } from "../src/core/plan-reviewer.ts";
import { applyPlanAction, type TaskPlan } from "../src/core/task-plan.ts";

// Same scripted-model idiom as background-agent.test.ts / explorer.test.ts.
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
		api: "openai-completions",
		provider: "openrouter",
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

function toolCallMessage(id: string): AssistantMessage {
	return assistant("", {
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "" },
			{ type: "toolCall", id, name: "ls", arguments: {} },
		],
	});
}

const VERDICT_OK = `{"verdict": "ok", "findings": []}`;

/** Scripts one assistant reply per model call and records each call's tool list. */
function fakeRuntime(script: (call: number) => AssistantMessage): {
	runtime: ModelRuntime;
	callCount: () => number;
	toolsSeen: () => (readonly string[])[];
} {
	let call = 0;
	const toolsSeen: (readonly string[])[] = [];
	const runtime = {
		getModel: (_provider: string, id: string) => ({
			id,
			provider: "openrouter",
			api: "openai-completions",
			maxTokens: 8000,
			compat: {},
		}),
		streamSimple: (_model: unknown, context: Context) => {
			call++;
			toolsSeen.push((context.tools ?? []).map((t) => t.name));
			const message = script(call);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	} as unknown as ModelRuntime;
	return { runtime, callCount: () => call, toolsSeen: () => toolsSeen };
}

function plan(): TaskPlan {
	const result = applyPlanAction(
		undefined,
		{ action: "create", goal: "g", items: ["a.ts"], verify: "npm test", verify_command: "npm test" },
		{ runMessages: [], request: "do the thing", now: new Date(0) },
	);
	if (!result.plan) throw new Error(result.error);
	return result.plan;
}

describe("reviewOnce - forced no-tools verdict on budget stop (issue: 2026-09-28 evidence)", () => {
	it("returns the forced turn's verdict instead of throwing, and the forced call has no tools", async () => {
		const { runtime, callCount, toolsSeen } = fakeRuntime((call) =>
			call <= MAX_TURNS ? toolCallMessage(`call_${call}`) : assistant(VERDICT_OK),
		);

		const outcome = await reviewOnce({
			plan: plan(),
			diff: "diff",
			verifyOutput: "ok",
			locations: [],
			cwd: process.cwd(),
			modelRuntime: runtime,
		});

		expect(outcome.verdict).toBe("ok");
		// MAX_TURNS turns to exhaust the budget, plus exactly one forced turn - no more.
		expect(callCount()).toBe(MAX_TURNS + 1);
		expect(toolsSeen()[0]).not.toEqual([]);
		expect(toolsSeen()[MAX_TURNS]).toEqual([]);
	});

	it("still throws 'budget ran out before a verdict' when the forced turn also returns garbage", async () => {
		const { runtime, callCount } = fakeRuntime((call) =>
			call <= MAX_TURNS ? toolCallMessage(`call_${call}`) : assistant("still not sure, let me think more"),
		);

		await expect(
			reviewOnce({
				plan: plan(),
				diff: "diff",
				verifyOutput: "ok",
				locations: [],
				cwd: process.cwd(),
				modelRuntime: runtime,
			}),
		).rejects.toThrow("budget ran out before a verdict");
		// Exactly one forced turn on top of the budgeted ones - no recursion/loop.
		expect(callCount()).toBe(MAX_TURNS + 1);
	});

	it("makes no extra call when a verdict comes back within budget", async () => {
		const { runtime, callCount } = fakeRuntime(() => assistant(VERDICT_OK));

		const outcome = await reviewOnce({
			plan: plan(),
			diff: "diff",
			verifyOutput: "ok",
			locations: [],
			cwd: process.cwd(),
			modelRuntime: runtime,
		});

		expect(outcome.verdict).toBe("ok");
		expect(callCount()).toBe(1);
	});
});

describe("reviewPlan retry with the forced-verdict path", () => {
	it("skips after two failed attempts when both hit the budget with no salvageable verdict", async () => {
		const attemptSize = MAX_TURNS + 1; // budgeted turns + 1 forced turn per attempt
		const { runtime } = fakeRuntime((call) => {
			const inAttempt = ((call - 1) % attemptSize) + 1;
			return inAttempt <= MAX_TURNS ? toolCallMessage(`call_${call}`) : assistant("no verdict here either");
		});

		const result = await reviewPlan({
			plan: plan(),
			diff: "diff",
			verifyOutput: "ok",
			locations: [],
			cwd: process.cwd(),
			modelRuntime: runtime,
		});

		expect(result).toEqual({ skipped: "budget ran out before a verdict" });
	});
});
