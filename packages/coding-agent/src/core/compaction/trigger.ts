import type { AgentMessage } from "theoses-agent-core";
import type { Api, AssistantMessage, Model } from "theoses-ai";
import { isContextOverflow, isRecoverableLength } from "theoses-ai/compat";
import { getLatestCompactionEntry, type SessionEntry } from "../session-manager.ts";
import {
	type CompactionSettings,
	calculateContextTokens,
	countUserTurnsSince,
	estimateContextTokens,
	historyTurnHardCap,
	lastCompactionBoundary,
	shouldCompact,
	shouldCompactByTurns,
	shouldDeferCompactionForCache,
} from "./compaction.ts";
import type { CompactionReason } from "./run.ts";

/**
 * Compaction Trigger (CONTEXT.md): the decision, after an assistant message, of whether to compact and why. It reads
 * a snapshot and returns what to do; the caller applies it (sets the recovery flag, drops the failed message, starts the
 * Compaction Run). The automatic cases:
 * 1. Overflow with retry: a context-overflow error or a recoverable length stop. The caller removes the failed
 *    message, compacts, and retries the turn once.
 * 2. Overflow without retry: a successful response exceeded the configured context window. Compact, keep the response.
 * 3. Threshold: valid or estimated context usage crossed the configured threshold. Compact, no retry.
 * 4. Turns: the history reached its turn cap and the provider cache has gone cold (see `shouldDeferCompactionForCache`).
 */

export interface CompactionTriggerSnapshot {
	settings: CompactionSettings;
	/** The message the decision is about: the one the last turn ended on. */
	assistantMessage: AssistantMessage;
	/** False for the pre-prompt check, which also looks at aborted messages. */
	skipAbortedCheck: boolean;
	model: Pick<Model<Api>, "provider" | "id" | "contextWindow" | "maxTokens"> | undefined;
	/** The session branch, root to leaf. */
	branch: SessionEntry[];
	/** The messages the agent holds now, for the usage estimate. */
	messages: AgentMessage[];
	/** An overflow compact-and-retry already ran for this operation. */
	overflowRecoveryAttempted: boolean;
	nowMs: number;
}

export type CompactionDecision =
	| { kind: "none" }
	| { kind: "compact"; reason: Exclude<CompactionReason, "manual">; willRetry: boolean }
	/** Overflow recovery already ran once and the response overflowed again. */
	| { kind: "recovery-failed"; errorMessage: string };

export function decideCompaction(snapshot: CompactionTriggerSnapshot): CompactionDecision {
	const { settings, assistantMessage, model, branch, messages, nowMs } = snapshot;
	if (!settings.enabled) return { kind: "none" };

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (snapshot.skipAbortedCheck && assistantMessage.stopReason === "aborted") return { kind: "none" };

	const contextWindow = model?.contextWindow ?? 0;

	// Skip overflow check if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model.
	const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

	// Skip compaction checks if this assistant message is older than the latest
	// compaction boundary. This prevents a stale pre-compaction usage/error
	// from retriggering compaction on the first prompt after compaction.
	const compactionEntry = getLatestCompactionEntry(branch);
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) return { kind: "none" };

	// Cases 1 and 2: context overflow.
	// A length stop is recoverable when output ended below the model's original desired limit,
	// independent of the configured context size or any context-clamped provider request limit.
	const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
	const recoverableLength = sameModel && isRecoverableLength(assistantMessage, model?.maxTokens ?? 0);
	if (contextOverflow || recoverableLength) {
		const willRetry = assistantMessage.stopReason !== "stop";

		// Case 2: the response completed successfully. Compact, but do not retry because
		// agent.continue() cannot continue from a completed assistant response.
		if (!willRetry) return { kind: "compact", reason: "overflow", willRetry: false };

		if (snapshot.overflowRecoveryAttempted) {
			const errorMessage = contextOverflow
				? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
				: "Truncated response recovery failed after one compact-and-retry attempt.";
			return { kind: "recovery-failed", errorMessage };
		}

		// Case 1.
		return { kind: "compact", reason: "overflow", willRetry };
	}

	// Case 3: threshold compaction without retry.
	// For error messages or all-zero usage messages, estimate from the last valid response.
	// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
	// responses can still compact and do not reset context accounting.
	let contextTokens: number;
	const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
	if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
		const estimate = estimateContextTokens(messages);
		// Without provider usage, estimate.tokens is the pure message-size estimate.
		// Only usage-backed estimates need the stale pre-compaction check.
		if (estimate.lastUsageIndex !== null) {
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return { kind: "none" };
			}
		}
		contextTokens = estimate.tokens;
	} else {
		contextTokens = directContextTokens;
	}
	if (shouldCompact(contextTokens, contextWindow, settings)) {
		return { kind: "compact", reason: "threshold", willRetry: false };
	}

	// Case 4: turns.
	if (shouldCompactByTurns(branch, settings)) {
		// Compaction rewrites the prompt prefix, so hold it until the provider cache has gone cold.
		// The post-run check always sees a warm cache; the pre-prompt check of a later turn sees the
		// real idle gap since the last response.
		const idleMs = nowMs - assistantMessage.timestamp;
		const deferred = shouldDeferCompactionForCache(branch, settings, idleMs);
		if (process.env.THEOSES_DEBUG_CACHE_PREFIX) {
			const turns = countUserTurnsSince(branch, lastCompactionBoundary(branch));
			console.error(
				`[cache-prefix] turn compaction wanted: turns=${turns} cap=${historyTurnHardCap(settings)} idleMs=${idleMs} -> ${deferred ? "deferred" : "running"}`,
			);
		}
		if (deferred) return { kind: "none" };
		return { kind: "compact", reason: "turns", willRetry: false };
	}
	return { kind: "none" };
}
