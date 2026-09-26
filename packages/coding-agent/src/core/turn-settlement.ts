import type { AgentSession } from "./agent-session.ts";
import { findLastUserMessageEntryId, maybeDetectTaskBoundary } from "./task-boundary-detector.ts";

/**
 * Turn Settlement: the fire-and-forget work after a Channel Session turn ends successfully. Triggered
 * by AgentSession once an operation finishes (outcome "completed" after any retries, channel other than "cli");
 * adapters never call it. Never blocks or throws into the reply path.
 *
 * `userText` is a parameter, not derived from the session log, because it can differ from what was
 * stored (Telegram passes "" via PromptOptions.settlementText for attachment-only turns while the
 * stored message carries the attachment note).
 */
export function settleTurn(
	session: Pick<AgentSession, "sessionManager" | "modelRuntime" | "memoryPromotion">,
	userText: string,
): void {
	const { sessionManager: mainSessionManager, modelRuntime, memoryPromotion } = session;
	const { channel, channelSessionId } = mainSessionManager.getChannelSessionKey();
	memoryPromotion.settle(userText);
	// Issue #186, shadow mode: task-closure/topic-shift detection, separate from
	// consolidation's Jev trigger above — see task-boundary-detector.ts.
	const userMessageEntryId = findLastUserMessageEntryId(mainSessionManager.getBranch());
	if (userMessageEntryId) {
		maybeDetectTaskBoundary({
			channel,
			channelSessionId,
			userMessageText: userText,
			userMessageEntryId,
			mainSessionManager,
			modelRuntime,
		});
	}
}
