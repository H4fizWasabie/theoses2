import { contentText } from "theoses-ai";
import type { AgentSession } from "theoses-coding-agent";

// How a run used its tools, measured from the session's messages. This never decides whether a run was correct; the
// grader does. It only describes how the agent got there, so runs and models can be compared on cost of the same answer.
//
// Redundancy is deliberately narrow, so legitimate iteration is never counted:
//  - Only read-only tools (read, grep, find, ls) can be redundant.
//  - Any other tool call (edit, write, bash, ...) may change what a read returns, so it starts a new window; re-reading a
//    file after an edit to check the edit is not redundant.
//  - A failed call is never redundant: retrying after an error is recovery.
// "Semantically redundant" investigation (a different question with the same answer) is not measured; it needs a judge.

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
// ponytail: results shorter than this (a "no matches" line) are never "no new evidence"; searching a second pattern that
// also finds nothing is exploration. Raise it if short results turn out to be counted.
const MIN_EVIDENCE_CHARS = 80;

export type ToolUse = {
	/** Model requests: assistant messages. */
	rounds: number;
	toolCalls: number;
	toolErrors: number;
	/** A read-only call with the same tool and arguments as an earlier one, with no other tool call in between. */
	duplicateCalls: number;
	/** A read-only call, not an exact duplicate, whose result equals an earlier result in the same window. */
	noNewEvidenceCalls: number;
	/** The last assistant message's stop reason: "stop" for a normal finish. */
	terminationReason: string;
};

type Message = AgentSession["messages"][number];

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function measureToolUse(messages: readonly Message[]): ToolUse {
	const use: ToolUse = {
		rounds: 0,
		toolCalls: 0,
		toolErrors: 0,
		duplicateCalls: 0,
		noNewEvidenceCalls: 0,
		terminationReason: "none",
	};
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();
	const keyByCallId = new Map<string, string>();
	const duplicateIds = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant") {
			use.rounds += 1;
			use.terminationReason = message.stopReason;
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				use.toolCalls += 1;
				if (!READ_ONLY_TOOLS.has(part.name)) {
					seenCalls.clear();
					seenResults.clear();
					continue;
				}
				const key = `${part.name}\0${stableJson(part.arguments)}`;
				keyByCallId.set(part.id, key);
				if (seenCalls.has(key)) {
					use.duplicateCalls += 1;
					duplicateIds.add(part.id);
				}
				seenCalls.add(key);
			}
		} else if (message.role === "toolResult") {
			const key = keyByCallId.get(message.toolCallId);
			if (message.isError) {
				use.toolErrors += 1;
				// The failure gave no evidence, so trying the same call again is recovery, not a duplicate.
				if (key !== undefined) seenCalls.delete(key);
				continue;
			}
			if (key === undefined || duplicateIds.has(message.toolCallId)) continue;
			const text = contentText(message.content);
			if (text.length < MIN_EVIDENCE_CHARS) continue;
			if (seenResults.has(text)) use.noNewEvidenceCalls += 1;
			seenResults.add(text);
		}
	}
	return use;
}
