import type { ReplayTask } from "./replay-grader.ts";

// Real fixes from this repository's history. Each prompt is the bug as reported; the regression test that came with
// the fix is the grader (replay-grader.ts). Chosen because the test fails at the parent commit on an assertion, not on
// a missing name the agent could not have guessed.
export const replayTasks: ReplayTask[] = [
	{
		id: "retry-generic-finish-reason-error",
		fixCommit: "33c83f4bf",
		prompt:
			"A model sometimes garbles its own tool-call output mid-generation. OpenRouter then ends the response with an error whose message is `Provider finish_reason: error`. `isRetryableAssistantError` in packages/ai/src/utils/retry.ts does not treat that as retryable, so the turn just ends and the garbled text reaches the user. Retrying asks the model again and recovers, so make that failure retryable. Errors that mean a quota, billing or account limit must stay non-retryable.",
		testFile: "packages/ai/test/retry.test.ts",
	},
	{
		id: "retry-invalid-request-error",
		fixCommit: "7d3a2fd54",
		prompt:
			"When a provider answers HTTP 400 with an `invalid_request_error`, the request body itself was rejected, so sending it again fails the same way. OpenRouter wraps these responses as `Provider returned error`, which the retry classification in packages/ai/src/utils/retry.ts matches as a transient error, so the same rejected request is resent until the retries run out. A rejected request body must not be retried, even when it arrives wrapped that way.",
		testFile: "packages/ai/test/retry.test.ts",
	},
	{
		id: "auto-resume-timer-leak",
		fixCommit: "62155bf5b",
		prompt:
			"In packages/telegram/src/turn-queue.ts, scheduling an auto-resume twice for the same chat leaves the first timer running: only the second is remembered, so `cancelAutoResume` cannot reach the first and it still fires. A later `scheduleAutoResume` for a chat must replace the earlier one, so at most one resume can fire and cancelling stops it.",
		testFile: "packages/telegram/test/turn-queue.test.ts",
	},
	{
		id: "promotion-current-turn",
		fixCommit: "93709a19e",
		prompt:
			"When the model saves a note, `recordSaved` in packages/coding-agent/src/core/memory-promotion.ts marks the last 20 session entries as promoted to Durable Memory. In a tool-heavy turn that range does not reach back to the turn's user message, and in a short turn it also covers earlier user messages that were never saved, so compaction skips distilling them. Mark the turn that made the save: from its user message up to the save, nothing before it.",
		testFile: "packages/coding-agent/test/memory-promotion.test.ts",
	},
];
