/**
 * Operation Loop: after each agent run inside one operation, decides whether the operation continues
 * (retry, overflow recovery, compaction that leaves queued messages) or finishes, and runs that step.
 *
 * Order after a run ends on assistant message `msg`:
 * 1. A retryable error decided at agent_end: drop `msg`, back off, continue. A stop during the backoff
 *    turns the outcome into `aborted`.
 * 2. The Compaction Trigger. Overflow recovery drops `msg`, compacts and continues the same operation, so
 *    the operation finishes after it. Any other compaction runs after the operation finishes, so a crash
 *    there never reads as an interrupted task.
 * 3. Finish. Messages queued by agent_end extension handlers still need a continuation.
 *
 * The session owns the `agent.continue()` loop and what finishing means (`finish`); this module owns the
 * flags that carry decisions from agent events to the post-run step, and the retry budget.
 */

import type { Agent, AgentEvent } from "theoses-agent-core";
import type { AssistantMessage } from "theoses-ai/compat";
import { createRetryBudget, isContextOverflow, isRetryableAssistantError, type RetryEnd } from "theoses-ai/compat";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { CompactionRun } from "./compaction/run.ts";
import { type CompactionTriggerSnapshot, decideCompaction } from "./compaction/trigger.ts";
import type { OperationFinishedEntry } from "./session-manager.ts";

export interface OperationLoopDeps {
	agent: Pick<Agent, "state" | "hasQueuedMessages">;
	compactionRun: Pick<CompactionRun, "run" | "reportFailure">;
	getRetrySettings: Parameters<typeof createRetryBudget>[0];
	getCompactionSettings: () => CompactionTriggerSnapshot["settings"];
	getModel: () => CompactionTriggerSnapshot["model"];
	getBranch: () => CompactionTriggerSnapshot["branch"];
	emit: (event: Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>) => void;
	/** Records the one outcome of the operation. Called exactly once per pass that does not continue. */
	finish: (outcome: OperationFinishedEntry["outcome"], msg: AssistantMessage | undefined) => void;
}

export interface OperationLoop {
	/** Records agent_end; returns whether a retry follows, for the agent_end event the session emits. */
	agentEnded(event: Extract<AgentEvent, { type: "agent_end" }>): boolean;
	/** Tracks the other agent events the post-run step depends on. Call after the event is persisted. */
	observe(event: AgentEvent): void;
	/** Runs the post-run step. "continue" means the session calls `agent.continue()` and then this again. */
	afterRun(): Promise<"continue" | "done">;
	/** Pre-prompt compaction check (includes aborted messages). Never continues: the new prompt follows. */
	beforePrompt(lastAssistant: AssistantMessage): Promise<void>;
	/** Retries scheduled in the current run (0 when not retrying). */
	readonly retryAttempt: number;
	/** True while a retry backoff sleep is in progress. */
	readonly isRetrying: boolean;
	cancelRetry(): void;
}

export function createOperationLoop(deps: OperationLoopDeps): OperationLoop {
	const { agent } = deps;
	const retry = createRetryBudget(deps.getRetrySettings);
	let retryPending = false;
	let overflowRecoveryAttempted = false;
	let lastAssistant: AssistantMessage | undefined;

	const emitRetryEnd = (end: RetryEnd | undefined) => {
		if (end) deps.emit({ type: "auto_retry_end", ...end });
	};

	// The failed or truncated response stays in session history but leaves agent state, since
	// agent.continue() rejects a trailing assistant and the retry must not see it.
	const dropTrailingFailedAssistant = () => {
		const messages = agent.state.messages;
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "length")) {
			agent.state.messages = messages.slice(0, -1);
		}
	};

	const isRetryableError = (message: AssistantMessage) =>
		// Context overflow is handled by compaction, not retry.
		!isContextOverflow(message, deps.getModel()?.contextWindow ?? 0) && isRetryableAssistantError(message);

	/** Backs off before a retry; false when stop cancelled the sleep. */
	const prepareRetry = async (message: AssistantMessage): Promise<boolean> => {
		const schedule = retry.next(message);
		deps.emit({ type: "auto_retry_start", ...schedule });
		dropTrailingFailedAssistant();
		if (await retry.sleep(schedule.delayMs)) return true;
		emitRetryEnd(retry.finish(false, "Retry cancelled"));
		return false;
	};

	/**
	 * Applies the Compaction Trigger's decision. Returns whether to continue: after overflow recovery, or
	 * when a compaction completed while messages were queued.
	 */
	const checkCompaction = async (
		assistantMessage: AssistantMessage,
		skipAbortedCheck: boolean,
		beforeCompaction?: () => void,
	): Promise<boolean> => {
		const decision = decideCompaction({
			settings: deps.getCompactionSettings(),
			assistantMessage,
			skipAbortedCheck,
			model: deps.getModel(),
			branch: deps.getBranch(),
			messages: agent.state.messages,
			overflowRecoveryAttempted,
			nowMs: Date.now(),
		});
		if (decision.kind === "none") return false;
		if (decision.kind === "recovery-failed") {
			await deps.compactionRun.reportFailure("overflow", decision.errorMessage);
			return false;
		}

		if (decision.willRetry) {
			overflowRecoveryAttempted = true;
			dropTrailingFailedAssistant();
		} else {
			beforeCompaction?.();
		}
		const outcome = await deps.compactionRun.run({ reason: decision.reason, willRetry: decision.willRetry });
		if (outcome.kind !== "completed") return false;
		if (decision.willRetry) {
			// The response was persisted on message_end, so rebuilding state from the new compaction can
			// restore it as the final message. Drop it again before continuing the interrupted turn.
			dropTrailingFailedAssistant();
			return true;
		}
		return agent.hasQueuedMessages();
	};

	return {
		agentEnded(event) {
			let willRetry = false;
			if (!retry.exhausted) {
				for (let i = event.messages.length - 1; i >= 0; i--) {
					const message = event.messages[i];
					if (message.role === "assistant") {
						willRetry = isRetryableError(message as AssistantMessage);
						break;
					}
				}
			}
			retryPending = willRetry;
			return willRetry;
		},

		observe(event) {
			if (event.type === "message_start" && event.message.role === "user") {
				overflowRecoveryAttempted = false;
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message as AssistantMessage;
				lastAssistant = message;
				if (message.stopReason !== "error" && message.stopReason !== "length") overflowRecoveryAttempted = false;
				// A successful response ends the run of retries, so retries do not accumulate across a turn's calls.
				if (message.stopReason !== "error") emitRetryEnd(retry.finish(true));
			}
		},

		async afterRun() {
			const msg = lastAssistant;
			lastAssistant = undefined;
			if (!msg) {
				deps.finish("completed", undefined);
				return "done";
			}

			let outcome: OperationFinishedEntry["outcome"] =
				msg.stopReason === "aborted" ? "aborted" : msg.stopReason === "error" ? "failed" : "completed";
			if (retryPending) {
				retryPending = false;
				if (await prepareRetry(msg)) return "continue";
				outcome = "aborted";
			}

			if (msg.stopReason === "error") emitRetryEnd(retry.finish(false, msg.errorMessage));

			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				deps.finish(outcome, msg);
			};
			if (await checkCompaction(msg, true, finish)) return "continue";
			finish();

			// The agent loop drains both queues before agent_end. Anything here was queued by agent_end
			// extension handlers and needs a continuation.
			return agent.hasQueuedMessages() ? "continue" : "done";
		},

		async beforePrompt(assistantMessage) {
			await checkCompaction(assistantMessage, false);
		},

		get retryAttempt() {
			return retry.attempt;
		},
		get isRetrying() {
			return retry.isSleeping;
		},
		cancelRetry() {
			retry.cancel();
		},
	};
}
