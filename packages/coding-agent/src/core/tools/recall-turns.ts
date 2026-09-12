import type { AgentMessage } from "theoses-agent-core";
import { contentText } from "theoses-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { buildTermMatcher } from "../memory-store.ts";
import type { SessionEntry } from "../session-manager.ts";

const recallTurnsSchema = Type.Object({
	query: Type.String({ description: "What to search for in this session's own past turns" }),
});
type RecallTurnsInput = Static<typeof recallTurnsSchema>;

const MAX_RESULTS = 5;
const SNIPPET_MAX_CHARS = 300;

interface TurnRecord {
	role: "user" | "assistant";
	text: string;
	timestamp: string;
}

/**
 * Extracts only conversational text (user messages, assistant text blocks) from session entries -
 * never tool-call arguments, tool results, or thinking. Matches the same "chat only" boundary the
 * compacted-history summarizer already draws (serializeConversation in compaction/utils.ts skips
 * tool results from its own output for the same reason - they're arbitrary command/file output,
 * not conversation). This tool exists precisely so that boundary is safe to keep drawing: anything
 * genuinely needed from an aged-out tool result should come from the artifact system
 * (output-shaping.ts) or a fresh tool call, not from bringing raw tool output back through here.
 */
function extractTurnRecords(entries: SessionEntry[]): TurnRecord[] {
	const records: TurnRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: AgentMessage = entry.message;
		if (message.role === "user") {
			const text = contentText(message.content, "").trim();
			if (text) records.push({ role: "user", text, timestamp: entry.timestamp });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) records.push({ role: "assistant", text, timestamp: entry.timestamp });
		}
	}
	return records;
}

function snippetOf(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SNIPPET_MAX_CHARS ? `${oneLine.slice(0, SNIPPET_MAX_CHARS - 3)}...` : oneLine;
}

/**
 * Bounded lookback into this session's own turn history (issue #231) - the companion to
 * `remember` (durable, cross-session facts): this is session-scoped, searches only what this
 * Channel Session itself said, and exists so compaction (#230) and the Active Context Window can
 * keep pruning aggressively without that being a one-way door. Same keyword-overlap matching as
 * `remember` (buildTermMatcher, memory-store.ts) - deliberately not a raw offset/line read of the
 * session's own JSONL, which would reintroduce the exact unbounded-injection problem #228/#229
 * fixed, just one layer up.
 */
export function createRecallTurnsToolDefinition(): ToolDefinition<typeof recallTurnsSchema> {
	return {
		name: "recall_turns",
		label: "recall_turns",
		description:
			"Search this session's own past turns (user and assistant chat only, never tool output) for something that may have scrolled out of the active context or been compacted away. Use when you need a specific fact you or the user said earlier in this session and can't otherwise verify it.",
		promptSnippet: "Search this session's own past turns for something no longer in context",
		parameters: recallTurnsSchema,
		execute: async (_id, { query }: RecallTurnsInput, _signal, _onUpdate, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const records = extractTurnRecords(entries);
			const matcher = buildTermMatcher(query);
			if (matcher.terms.length === 0) {
				return { content: [{ type: "text", text: "No searchable terms in that query." }], details: undefined };
			}

			const scored = records
				.map((record) => ({ record, score: matcher.score(record.text) }))
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score || b.record.timestamp.localeCompare(a.record.timestamp))
				.slice(0, MAX_RESULTS);

			if (scored.length === 0) {
				return { content: [{ type: "text", text: "No matching turns found in this session." }], details: undefined };
			}

			const text = scored
				.map(({ record }) => `[${record.timestamp}] ${record.role}: ${snippetOf(record.text)}`)
				.join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
