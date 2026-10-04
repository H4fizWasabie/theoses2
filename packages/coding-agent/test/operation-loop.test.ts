import type { AgentEvent, AgentMessage } from "theoses-agent-core";
import type { AssistantMessage, Usage } from "theoses-ai";
import { describe, expect, it } from "vitest";
import type { CompactionResult } from "../src/core/compaction/compaction.ts";
import type { CompactionRunOutcome, CompactionRunRequest } from "../src/core/compaction/run.ts";
import { createOperationLoop, type OperationLoopDeps } from "../src/core/operation-loop.ts";

const MODEL = { provider: "p", id: "m", contextWindow: 10_000, maxTokens: 4_000 };

function usage(input: number): Usage {
	return {
		input,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "reply" }],
		api: "anthropic-messages",
		provider: MODEL.provider,
		model: MODEL.id,
		usage: usage(100),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

const user: AgentMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
const retryable = () => assistant({ stopReason: "error", errorMessage: "529 overloaded", usage: usage(0) });
const overflow = () => assistant({ stopReason: "error", errorMessage: "prompt is too long", usage: usage(0) });

/** A loop over a fake agent and Compaction Run; `log` records finish, run and emitted events in order. */
function setup(options: { baseDelayMs?: number; runOutcome?: CompactionRunOutcome["kind"] } = {}) {
	const log: string[] = [];
	const state = { messages: [user] as AgentMessage[], queued: false };
	let onRun: (() => void) | undefined;
	const deps: OperationLoopDeps = {
		agent: {
			state,
			hasQueuedMessages: () => state.queued,
		} as unknown as OperationLoopDeps["agent"],
		compactionRun: {
			run: async (request: CompactionRunRequest) => {
				log.push(`run:${request.reason}:willRetry=${request.willRetry}`);
				onRun?.();
				const kind = options.runOutcome ?? "completed";
				return kind === "completed"
					? { kind, result: {} as CompactionResult }
					: kind === "skipped"
						? { kind }
						: { kind, error: new Error(kind) };
			},
			reportFailure: async (reason, errorMessage) => {
				log.push(`reportFailure:${reason}:${errorMessage.split(" ")[0]}`);
			},
		},
		getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: options.baseDelayMs ?? 0 }),
		getCompactionSettings: () => ({
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 100,
			maxHistoryTurns: 0,
			maxDeferredTurns: 0,
		}),
		getModel: () => MODEL,
		getBranch: () => [],
		emit: (event) => log.push(event.type === "auto_retry_start" ? "retry_start" : `retry_end:${event.success}`),
		finish: (outcome) => log.push(`finish:${outcome}`),
	};
	const loop = createOperationLoop(deps);

	/** Feeds the events of one agent run that ended on `message`. */
	const runEndingOn = (message: AssistantMessage) => {
		state.messages.push(message);
		loop.observe({ type: "message_end", message } as AgentEvent);
		return loop.agentEnded({ type: "agent_end", messages: [message] } as Extract<AgentEvent, { type: "agent_end" }>);
	};
	return {
		loop,
		log,
		state,
		runEndingOn,
		setOnRun: (fn: () => void) => {
			onRun = fn;
		},
	};
}

describe("Operation Loop", () => {
	it("finishes completed when the run produced no assistant message", async () => {
		const { loop, log } = setup();

		await expect(loop.afterRun()).resolves.toBe("done");
		expect(log).toEqual(["finish:completed"]);
	});

	it("finishes a plain reply without compacting", async () => {
		const { loop, log, runEndingOn } = setup();

		expect(runEndingOn(assistant())).toBe(false);
		await expect(loop.afterRun()).resolves.toBe("done");
		expect(log).toEqual(["finish:completed"]);
	});

	it("retries a retryable error inside the operation, then reports the retry run ended on success", async () => {
		const { loop, log, state, runEndingOn } = setup();

		expect(runEndingOn(retryable())).toBe(true);
		await expect(loop.afterRun()).resolves.toBe("continue");
		expect(state.messages).toEqual([user]);
		expect(loop.retryAttempt).toBe(1);

		runEndingOn(assistant());
		await expect(loop.afterRun()).resolves.toBe("done");
		expect(log).toEqual(["retry_start", "retry_end:true", "finish:completed"]);
		expect(loop.retryAttempt).toBe(0);
	});

	it("stops retrying once the budget is exhausted and finishes failed", async () => {
		const { loop, log, runEndingOn } = setup();

		for (let i = 0; i < 2; i++) {
			expect(runEndingOn(retryable())).toBe(true);
			await expect(loop.afterRun()).resolves.toBe("continue");
		}
		expect(runEndingOn(retryable())).toBe(false);
		await expect(loop.afterRun()).resolves.toBe("done");
		expect(log).toEqual(["retry_start", "retry_start", "retry_end:false", "finish:failed"]);
	});

	it("finishes aborted when stop cancels the retry backoff", async () => {
		const { loop, log, runEndingOn } = setup({ baseDelayMs: 60_000 });

		runEndingOn(retryable());
		const pending = loop.afterRun();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loop.isRetrying).toBe(true);
		loop.cancelRetry();

		await expect(pending).resolves.toBe("done");
		expect(log).toEqual(["retry_start", "retry_end:false", "finish:aborted"]);
	});

	it("recovers from overflow once inside the operation, dropping the failed response again after the rebuild", async () => {
		const { loop, log, state, runEndingOn, setOnRun } = setup();
		const failed = overflow();
		// Rebuilding agent state from the new compaction restores the persisted failed response.
		setOnRun(() => state.messages.push(failed));

		expect(runEndingOn(failed)).toBe(false);
		await expect(loop.afterRun()).resolves.toBe("continue");
		expect(state.messages).toEqual([user]);
		expect(log).toEqual(["run:overflow:willRetry=true"]);

		runEndingOn(overflow());
		await expect(loop.afterRun()).resolves.toBe("done");
		expect(log).toEqual(["run:overflow:willRetry=true", "reportFailure:overflow:Context", "finish:failed"]);
	});

	it("allows overflow recovery again after a new user message", async () => {
		const { loop, log, runEndingOn } = setup();

		runEndingOn(overflow());
		await loop.afterRun();
		loop.observe({ type: "message_start", message: user } as AgentEvent);
		runEndingOn(overflow());
		await expect(loop.afterRun()).resolves.toBe("continue");
		expect(log).toEqual(["run:overflow:willRetry=true", "run:overflow:willRetry=true"]);
	});

	it("finishes the operation before threshold compaction, and continues for queued messages", async () => {
		const { loop, log, state, runEndingOn } = setup();
		state.queued = true;

		runEndingOn(assistant({ usage: usage(9_500) }));
		await expect(loop.afterRun()).resolves.toBe("continue");
		expect(log).toEqual(["finish:completed", "run:threshold:willRetry=false"]);
	});

	it("continues for messages queued by agent_end handlers when nothing compacts", async () => {
		const { loop, log, state, runEndingOn } = setup();
		state.queued = true;

		runEndingOn(assistant());
		await expect(loop.afterRun()).resolves.toBe("continue");
		expect(log).toEqual(["finish:completed"]);
	});

	it("checks compaction before a prompt without continuing or finishing", async () => {
		const { loop, log } = setup();

		await loop.beforePrompt(assistant({ stopReason: "aborted", usage: usage(9_500) }));
		expect(log).toEqual(["run:threshold:willRetry=false"]);
	});
});
