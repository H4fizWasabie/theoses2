import type { AgentMessage } from "theoses-agent-core";
import type { AssistantMessage, Usage } from "theoses-ai";
import { describe, expect, it } from "vitest";
import { CACHE_WARM_WINDOW_MS, type CompactionSettings } from "../src/core/compaction/compaction.ts";
import { type CompactionTriggerSnapshot, decideCompaction } from "../src/core/compaction/trigger.ts";
import type { CompactionEntry, SessionEntry } from "../src/core/session-manager.ts";

const NOW = 2_000_000_000_000;
const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 1000,
	keepRecentTokens: 100,
	maxHistoryTurns: 3,
	maxDeferredTurns: 0,
};
const MODEL = { provider: "p", id: "m", contextWindow: 10_000, maxTokens: 4_000 };

function usage(input: number, output = 10): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
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
		timestamp: NOW - 1000,
		...overrides,
	};
}

function userEntry(index: number): SessionEntry {
	return {
		type: "message",
		id: `u${index}`,
		parentId: null,
		timestamp: new Date(NOW).toISOString(),
		message: { role: "user", content: `question ${index}`, timestamp: NOW },
	};
}

function compactionEntry(at: number): CompactionEntry {
	return {
		type: "compaction",
		id: "c1",
		parentId: null,
		timestamp: new Date(at).toISOString(),
		summary: "summary",
		firstKeptEntryId: "u0",
		tokensBefore: 5000,
	};
}

function decide(overrides: Partial<CompactionTriggerSnapshot> = {}) {
	return decideCompaction({
		settings: SETTINGS,
		assistantMessage: assistant(),
		skipAbortedCheck: true,
		model: MODEL,
		branch: [],
		messages: [],
		overflowRecoveryAttempted: false,
		nowMs: NOW,
		...overrides,
	});
}

const users = (count: number) => Array.from({ length: count }, (_, i) => userEntry(i));

describe("decideCompaction", () => {
	it("does nothing when compaction is disabled", () => {
		const decision = decide({
			settings: { ...SETTINGS, enabled: false },
			assistantMessage: assistant({ usage: usage(9500) }),
		});
		expect(decision).toEqual({ kind: "none" });
	});

	it("skips an aborted message, unless the pre-prompt check asks to include it", () => {
		const aborted = assistant({ stopReason: "aborted", usage: usage(9500) });
		expect(decide({ assistantMessage: aborted })).toEqual({ kind: "none" });
		expect(decide({ assistantMessage: aborted, skipAbortedCheck: false })).toEqual({
			kind: "compact",
			reason: "threshold",
			willRetry: false,
		});
	});

	it("ignores a message older than the latest compaction", () => {
		const decision = decide({
			assistantMessage: assistant({ usage: usage(9500), timestamp: NOW - 5000 }),
			branch: [compactionEntry(NOW - 1000)],
		});
		expect(decision).toEqual({ kind: "none" });
	});

	describe("overflow", () => {
		const overflowed = (overrides: Partial<AssistantMessage> = {}) =>
			assistant({ stopReason: "length", usage: usage(9950, 0), ...overrides });

		it("compacts a successful response that exceeded the context window, without retry", () => {
			const decision = decide({ assistantMessage: assistant({ usage: usage(11_000) }) });
			expect(decision).toEqual({ kind: "compact", reason: "overflow", willRetry: false });
		});

		it("compacts and retries a failed overflow once", () => {
			expect(decide({ assistantMessage: overflowed() })).toEqual({
				kind: "compact",
				reason: "overflow",
				willRetry: true,
			});
		});

		it("reports failure when recovery already ran", () => {
			const decision = decide({ assistantMessage: overflowed(), overflowRecoveryAttempted: true });
			expect(decision).toMatchObject({ kind: "recovery-failed" });
			expect(decision.kind === "recovery-failed" && decision.errorMessage).toContain(
				"Context overflow recovery failed",
			);
		});

		it("treats a length stop below the desired output limit as recoverable", () => {
			const truncated = assistant({ stopReason: "length", usage: usage(100, 100) });
			expect(decide({ assistantMessage: truncated })).toEqual({
				kind: "compact",
				reason: "overflow",
				willRetry: true,
			});

			const decision = decide({ assistantMessage: truncated, overflowRecoveryAttempted: true });
			expect(decision.kind === "recovery-failed" && decision.errorMessage).toContain(
				"Truncated response recovery failed",
			);
		});

		it("does not retry a length stop that reached the desired output limit", () => {
			const atLimit = assistant({ stopReason: "length", usage: usage(100, MODEL.maxTokens) });
			expect(decide({ assistantMessage: atLimit })).toEqual({ kind: "none" });
		});

		it("does not read an overflow from a different model as overflow", () => {
			const decision = decide({ assistantMessage: overflowed({ model: "other" }) });
			expect(decision).toEqual({ kind: "compact", reason: "threshold", willRetry: false });
		});
	});

	describe("threshold", () => {
		it("compacts when reported usage crosses the threshold, not below it", () => {
			expect(decide({ assistantMessage: assistant({ usage: usage(9500) }) })).toEqual({
				kind: "compact",
				reason: "threshold",
				willRetry: false,
			});
			expect(decide({ assistantMessage: assistant({ usage: usage(5000) }) })).toEqual({ kind: "none" });
		});

		const errored = assistant({ stopReason: "error", errorMessage: "529", usage: usage(0, 0), timestamp: NOW - 100 });
		const lastGoodReply = (timestamp: number): AgentMessage[] => [
			{ role: "user", content: "q", timestamp: NOW - 5000 },
			assistant({ usage: usage(9500), timestamp }),
		];

		it("estimates from the last good response when the message has an error or no usage", () => {
			const decision = decide({ assistantMessage: errored, messages: lastGoodReply(NOW - 2000) });
			expect(decision).toEqual({ kind: "compact", reason: "threshold", willRetry: false });
		});

		it("does not trust a usage estimate that predates the latest compaction", () => {
			const decision = decide({
				assistantMessage: errored,
				messages: lastGoodReply(NOW - 2000),
				branch: [compactionEntry(NOW - 1000)],
			});
			expect(decision).toEqual({ kind: "none" });
		});

		it("does nothing for an error when there is no earlier usage to estimate from", () => {
			expect(decide({ assistantMessage: errored })).toEqual({ kind: "none" });
		});
	});

	describe("turns", () => {
		const deferring = { ...SETTINGS, maxDeferredTurns: 2 };

		it("compacts once the history passes its turn cap", () => {
			expect(decide({ branch: users(3) })).toEqual({ kind: "none" });
			expect(decide({ branch: users(4) })).toEqual({ kind: "compact", reason: "turns", willRetry: false });
		});

		it("waits for the provider cache to go cold while within the deferred turns", () => {
			const warm = assistant({ timestamp: NOW - 1000 });
			expect(decide({ settings: deferring, branch: users(4), assistantMessage: warm })).toEqual({ kind: "none" });

			const cold = assistant({ timestamp: NOW - CACHE_WARM_WINDOW_MS });
			expect(decide({ settings: deferring, branch: users(4), assistantMessage: cold })).toEqual({
				kind: "compact",
				reason: "turns",
				willRetry: false,
			});
		});

		it("stops waiting past the hard cap even when the cache is warm", () => {
			const decision = decide({ settings: deferring, branch: users(6) });
			expect(decision).toEqual({ kind: "compact", reason: "turns", willRetry: false });
		});
	});
});
