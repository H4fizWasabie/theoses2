/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "theoses-agent-core";
import { contentText, type Message } from "theoses-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Each compaction seeds its file-op tracking from the previous compaction's own tracked lists
 * (see extractFileOperations in compaction.ts), so without a cap these lists grow for the entire
 * life of a session - every path ever read or touched, still reprinted on every future turn, long
 * after it stopped being relevant (issue #228). This bounds each list to the most recently
 * touched paths; anything older is dropped rather than carried forward indefinitely.
 */
const MAX_TRACKED_FILES = 40;

/** Treats a Set's insertion order as recency and keeps only the most recent MAX_TRACKED_FILES. */
function capToRecent(paths: Set<string>): { kept: string[]; droppedCount: number } {
	const all = [...paths];
	if (all.length <= MAX_TRACKED_FILES) return { kept: all, droppedCount: 0 };
	return { kept: all.slice(-MAX_TRACKED_FILES), droppedCount: all.length - MAX_TRACKED_FILES };
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles, each capped to the most
 * recently touched MAX_TRACKED_FILES with a count of how many older paths were dropped - the
 * capped lists are also what gets persisted for the next compaction to seed from, so the bound
 * holds across the whole session rather than resetting once and re-growing unbounded again.
 */
export function computeFileLists(fileOps: FileOperations): {
	readFiles: string[];
	modifiedFiles: string[];
	droppedReadCount: number;
	droppedModifiedCount: number;
} {
	const modifiedSet = new Set([...fileOps.edited, ...fileOps.written]);
	const { kept: modifiedKept, droppedCount: droppedModifiedCount } = capToRecent(modifiedSet);
	const modifiedFiles = modifiedKept.sort();

	const readOnlySet = new Set([...fileOps.read].filter((f) => !modifiedSet.has(f)));
	const { kept: readKept, droppedCount: droppedReadCount } = capToRecent(readOnlySet);
	const readFiles = readKept.sort();

	return { readFiles, modifiedFiles, droppedReadCount, droppedModifiedCount };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	droppedReadCount = 0,
	droppedModifiedCount = 0,
): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		const note = droppedReadCount > 0 ? `\n(+${droppedReadCount} older read files omitted)` : "";
		sections.push(`<read-files>\n${readFiles.join("\n")}${note}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		const note = droppedModifiedCount > 0 ? `\n(+${droppedModifiedCount} older modified files omitted)` : "";
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}${note}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Hard ceiling on a compaction summary's own prose (issue #230). UPDATE_SUMMARIZATION_INSTRUCTIONS
 * tells the model to "preserve all existing information from the previous summary" on every update
 * pass - a genuine topic shift already drops the whole summary via chainReset (#186), but a single
 * long-running task that never crosses a topic boundary has no other pruning trigger, so the prose
 * can otherwise grow for as long as the task keeps going. This is a backstop, not the primary
 * mechanism: deliberately generous, since unlike a single tool result this text is what the next
 * turn relies on to keep working correctly. Keeps the beginning - the summary's own template puts
 * the durable framing (## Goal, ## Constraints & Preferences) first and the more situational
 * ## Critical Context last, so a truncation cuts the part most likely to already be stale before
 * it cuts the part still needed for continuity.
 */
export const MAX_SUMMARY_CHARS = 12_000;

export function capSummaryLength(summary: string): string {
	if (summary.length <= MAX_SUMMARY_CHARS) return summary;
	const truncatedChars = summary.length - MAX_SUMMARY_CHARS;
	return `${summary.slice(0, MAX_SUMMARY_CHARS)}\n\n[... ${truncatedChars} more characters of this summary truncated - it exceeded its length budget]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
