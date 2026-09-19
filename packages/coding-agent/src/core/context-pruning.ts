/**
 * Shrinks the tool output that a finished turn leaves in the live context.
 *
 * Every tool result and tool-call argument stays in the conversation, and is sent to the provider
 * again on each later request, until compaction drops its turn. Individual results are already capped
 * at 6-12 KB, but a long loop leaves hundreds of them: on prod, 684 results on one day totalled 655k
 * characters, and results over 1,500 characters were 17% of the results but 39% of the characters.
 *
 * This runs once, when a user turn starts (see AgentSession.prompt), and only touches messages from
 * turns that have already finished. That timing is what keeps the prompt cache intact: at a new turn
 * start the previous turn's assistant messages are already rewritten (reasoning is dropped from
 * earlier turns), so the first changed message is that turn's start whether or not it is pruned.
 * The result is deterministic, so every request inside the turn sends the same pruned messages.
 *
 * Only the live message list changes. The session log keeps the original text, so consolidation,
 * backfill and replays still see full transcripts. The full text of anything cut is written to the
 * session's artifact directory and its path is left in the marker, so the model can `read` it.
 */
import type { AgentMessage } from "theoses-agent-core";

/** Below this the marker itself would not fit inside the cap, so pruning would not shrink anything. */
export const MIN_PRUNING_CAP_CHARS = 400;

const HEAD_SHARE = 0.6;
const TAIL_SHARE = 0.2;
const MARKER_PREFIX = "[... ";
/** Fixed wording of every marker, also how an already-cut text is recognised so it is not cut twice. */
const MARKER_SIGNATURE = "omitted from this earlier";

export interface ContextPruningOptions {
	/** Tool results over this many characters of text are cut. 0 disables. */
	toolResultMaxChars: number;
	/** String values inside tool-call arguments over this many characters are cut. 0 disables. */
	toolCallArgsMaxChars: number;
	/**
	 * Persists the full text of something being cut and returns the path it can be read from, or
	 * undefined if that is not possible (no session directory, write error). `name` is a stable,
	 * filesystem-safe file name so the same input always maps to the same file.
	 */
	spill?: (name: string, text: string) => string | undefined;
}

export interface ContextPruningStats {
	toolResults: number;
	toolCallArguments: number;
	charsRemoved: number;
}

export interface ContextPruningResult {
	messages: AgentMessage[];
	stats: ContextPruningStats;
}

/** Keeps a configured cap usable: 0 stays off, anything from 1 up to the minimum is raised to it. */
export function effectiveCap(cap: number): number {
	if (!Number.isFinite(cap) || cap <= 0) return 0;
	return Math.max(MIN_PRUNING_CAP_CHARS, Math.floor(cap));
}

function isPrunedText(text: string): boolean {
	return text.includes(MARKER_PREFIX) && text.includes(MARKER_SIGNATURE);
}

/** Head, marker, tail. The marker names what was cut (`describe`, e.g. "bash output") and where the full text lives. */
function shrinkText(text: string, cap: number, describe: string, path: string | undefined): string {
	const head = text.slice(0, Math.floor(cap * HEAD_SHARE));
	const tail = text.slice(text.length - Math.floor(cap * TAIL_SHARE));
	const omitted = text.length - head.length - tail.length;
	const where = path ? `; full text saved at ${path}, read it with the read tool` : "";
	return `${head}\n\n${MARKER_PREFIX}${omitted} chars ${MARKER_SIGNATURE} ${describe}${where} ...]\n\n${tail}`;
}

function safeFileStem(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "call";
}

function pruneToolResult(
	message: AgentMessage,
	cap: number,
	spill: ContextPruningOptions["spill"],
	stats: ContextPruningStats,
): AgentMessage {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
	const textBlocks = message.content.filter(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	const total = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
	if (total <= cap) return message;
	const raw = textBlocks.map((block) => block.text).join("\n");
	if (isPrunedText(raw)) return message;

	const path = spill?.(`result-${safeFileStem(message.toolCallId)}.txt`, raw);
	const shrunk = shrinkText(raw, cap, `${message.toolName} output`, path);
	// One text block carrying the excerpt; anything that is not text (images) is left as it was.
	const rest = message.content.filter((block) => block.type !== "text");
	stats.toolResults++;
	stats.charsRemoved += raw.length - shrunk.length;
	return { ...message, content: [{ type: "text", text: shrunk }, ...rest] };
}

/** Cuts long strings anywhere inside an arguments object, keeping its shape and keys. */
function shrinkArguments(
	value: unknown,
	cap: number,
	path: string | undefined,
	describe: string,
	stats: ContextPruningStats,
): unknown {
	if (typeof value === "string") {
		if (value.length <= cap || isPrunedText(value)) return value;
		const shrunk = shrinkText(value, cap, describe, path);
		stats.charsRemoved += value.length - shrunk.length;
		return shrunk;
	}
	if (Array.isArray(value)) return value.map((item) => shrinkArguments(item, cap, path, describe, stats));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, shrinkArguments(inner, cap, path, describe, stats)]),
		);
	}
	return value;
}

function hasLongString(value: unknown, cap: number): boolean {
	if (typeof value === "string") return value.length > cap && !isPrunedText(value);
	if (Array.isArray(value)) return value.some((item) => hasLongString(item, cap));
	if (typeof value === "object" && value !== null)
		return Object.values(value).some((inner) => hasLongString(inner, cap));
	return false;
}

function pruneAssistantToolCalls(
	message: AgentMessage,
	cap: number,
	spill: ContextPruningOptions["spill"],
	stats: ContextPruningStats,
): AgentMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "toolCall" || !hasLongString(block.arguments, cap)) return block;
		// One file holds the whole argument object, whatever number of strings inside it were cut.
		const path = spill?.(`args-${safeFileStem(block.id)}.json`, JSON.stringify(block.arguments, null, 2));
		const before = stats.charsRemoved;
		const shrunk = shrinkArguments(block.arguments, cap, path, `${block.name} call`, stats);
		if (stats.charsRemoved === before) return block;
		changed = true;
		stats.toolCallArguments++;
		return { ...block, arguments: shrunk as Record<string, unknown> };
	});
	return changed ? { ...message, content } : message;
}

/**
 * Returns the messages with oversized tool results and tool-call arguments cut down. Call it only
 * with messages from finished turns (before the new user message is appended). Already-cut text
 * carries a marker and is left alone, so applying it again changes nothing.
 */
export function pruneFinishedTurnOutputs(
	messages: AgentMessage[],
	options: ContextPruningOptions,
): ContextPruningResult {
	const resultCap = effectiveCap(options.toolResultMaxChars);
	const argsCap = effectiveCap(options.toolCallArgsMaxChars);
	const stats: ContextPruningStats = { toolResults: 0, toolCallArguments: 0, charsRemoved: 0 };
	if (resultCap === 0 && argsCap === 0) return { messages, stats };

	let changed = false;
	const pruned = messages.map((message) => {
		let next = message;
		if (resultCap > 0) next = pruneToolResult(next, resultCap, options.spill, stats);
		if (argsCap > 0) next = pruneAssistantToolCalls(next, argsCap, options.spill, stats);
		if (next !== message) changed = true;
		return next;
	});
	return { messages: changed ? pruned : messages, stats };
}
