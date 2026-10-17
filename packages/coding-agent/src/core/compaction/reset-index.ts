import type { AgentMessage } from "theoses-agent-core";
import { spillEvictedToolResults } from "../context-pruning.ts";
import { firstLine, textOf, toolOutputIdOf } from "../tool-runs.ts";

/** Cap on the index text; the oldest turns go first. */
export const RESET_INDEX_MAX_CHARS = 6000;
const REQUEST_CHARS = 200;
const REPLY_EDGE_CHARS = 200;

interface Turn {
	request: string;
	reply: string;
	outputs: string[];
}

function replyEdges(reply: string): string {
	const text = reply.trim();
	if (text.length <= REPLY_EDGE_CHARS * 2) return text;
	return `${text.slice(0, REPLY_EDGE_CHARS)} ... ${text.slice(-REPLY_EDGE_CHARS)}`;
}

/**
 * What a task reset drops, as text for the compaction summary (#582): one entry per dropped turn with the request
 * line, the reply's head and tail, and the turn's tool-output ids with the files `spill` saved them to. Built once at
 * the reset and stored in the compaction entry, so later requests re-send the same bytes (ADR-0013). Nothing in it
 * depends on time or on how many turns came after.
 */
export function buildResetIndex(
	dropped: AgentMessage[],
	taskSummary: string,
	spill: (name: string, text: string) => string | undefined,
): string {
	const turns: Turn[] = [];
	for (const message of dropped) {
		if (message.role === "user") {
			turns.push({ request: firstLine(textOf(message.content), REQUEST_CHARS), reply: "", outputs: [] });
			continue;
		}
		const turn = turns[turns.length - 1];
		if (!turn) continue;
		if (message.role === "assistant") {
			const text = textOf(message.content.filter((block) => block.type === "text"));
			if (text.trim()) turn.reply = text;
		} else if (message.role === "toolResult") {
			const id = toolOutputIdOf(message.content);
			// One result at a time, so the path belongs to this id.
			let path: string | undefined;
			spillEvictedToolResults([message], (name, text) => {
				path = spill(name, text);
				return path;
			});
			if (id !== undefined && path) turn.outputs.push(`⟨t${id}⟩ ${path}`);
		}
	}

	const entries = turns.map((turn, i) => {
		const lines = [`${i + 1}. Request: ${turn.request}`, `   Reply: ${replyEdges(turn.reply) || "(none)"}`];
		if (turn.outputs.length > 0) lines.push(`   Outputs: ${turn.outputs.join("; ")}`);
		return lines.join("\n");
	});

	let start = 0;
	let size = entries.reduce((sum, entry) => sum + entry.length + 1, 0);
	while (size > RESET_INDEX_MAX_CHARS && start < entries.length - 1) size -= entries[start++].length + 1;

	const header = `Earlier task, dropped after a topic shift ("${taskSummary}"). Its turns, oldest first; read a saved output with the read tool instead of redoing the work.`;
	const note =
		start > 0
			? `\n(Index capped at ${RESET_INDEX_MAX_CHARS} characters: the ${start} oldest turns are left out.)`
			: "";
	return entries.length === 0 ? "" : `${header}${note}\n${entries.slice(start).join("\n")}`;
}
