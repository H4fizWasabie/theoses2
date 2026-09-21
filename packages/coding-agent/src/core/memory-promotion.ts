import type { AgentMessage } from "theoses-agent-core";
import type { DistilledMemoryResult } from "./compaction/compaction.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { SessionEntry } from "./session-manager.ts";
import { findLastUserMessageEntryId } from "./task-boundary-detector.ts";

/** The slice of SessionManager promotion needs: which entries already reached Durable Memory, and the log to mark. */
export interface PromotionLog {
	isEntryPromoted(entryId: string): boolean;
	appendPromotedRange(firstEntryId: string, lastEntryId: string): string;
	getBranch(): SessionEntry[];
}

/**
 * Memory promotion: how turns reach Durable Memory without being distilled twice. Compaction hands over the
 * messages it is about to drop (ADR-0001: the trigger is compaction's own cut point, not a turn counter) and this
 * distills only the ones no earlier save already covered; a model-invoked save marks its surrounding entries as
 * promoted so the next compaction skips them. The LLM call is supplied by the caller, so provider plumbing stays
 * out of here.
 */
export interface MemoryPromotion {
	/** Fire-and-forget. A failed pass is logged and swallowed: distillation is a safety net, never a reason to fail compaction. */
	distillDropped(
		messages: AgentMessage[],
		messageEntryIds: string[] | undefined,
		distill: (messages: AgentMessage[]) => Promise<DistilledMemoryResult>,
	): void;
	/** Call after the model saved a note: marks the current turn (last user message up to now) as promoted. */
	recordSaved(): void;
}

export function createMemoryPromotion(store: MemoryStore, log: PromotionLog): MemoryPromotion {
	return {
		distillDropped(messages, messageEntryIds, distill) {
			const unpromoted = messageEntryIds
				? messages.filter((_message, index) => !log.isEntryPromoted(messageEntryIds[index]!))
				: messages;
			if (unpromoted.length === 0) return;
			void distill(unpromoted)
				.then(({ facts, episode }) => {
					for (const fact of facts) store.saveNote(fact.fact);
					if (episode) store.saveNote(`Episode: ${episode}`);
				})
				.catch((error: unknown) => {
					console.warn("Memory distillation failed; continuing compaction.", error);
				});
		},
		recordSaved() {
			const entries = log.getBranch();
			// The fact came from this turn's work, which the model saw but cannot attribute more precisely.
			// ponytail: a fact taken from an earlier turn is distilled again at compaction (a harmless duplicate).
			const first = findLastUserMessageEntryId(entries);
			const last = entries[entries.length - 1];
			if (first && last) log.appendPromotedRange(first, last.id);
		},
	};
}
