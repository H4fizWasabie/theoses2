import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/** How many failed replies to keep. Old ones are dropped: this is for debugging the latest failures, not an archive. */
export const MAX_FAILED_BACKGROUND_RESPONSES = 20;

function failureLogPath(): string {
	return process.env.THEOSES_BACKGROUND_FAILURE_LOG ?? join(getAgentDir(), "failed-background-responses.jsonl");
}

/**
 * Shared evidence string for a background-model reply that did not have the shape a caller needed: the stop
 * reason, the top-level keys it did return (or that it was not JSON at all) and a short slice of its text.
 * Without it an error like "missing an episode" cannot tell an empty `{}` from a truncated or wrongly shaped answer.
 */
export function describeResponseShape(text: string, stopReason?: string): string {
	let keys: string;
	try {
		const parsed: unknown = JSON.parse(text);
		keys =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? `[${Object.keys(parsed).join(",")}]`
				: Array.isArray(parsed)
					? "array"
					: typeof parsed;
	} catch {
		keys = "not-json";
	}
	return `stopReason=${stopReason ?? "unknown"}, keys=${keys}, text=${JSON.stringify(text.slice(0, 300))}`;
}

export interface BackgroundFailureEntry {
	/** Which background call failed: "consolidation", "distillation", ... */
	caller: string;
	model: string;
	/** Upstream provider that served the call (AssistantMessage.responseProvider), when reported. */
	provider?: string;
	stopReason?: string;
	/** Why the caller rejected the reply. */
	error: string;
	/** The full raw reply, so the failure can be studied without reconstructing the prompt. */
	reply: string;
	promptChars?: number;
}

/**
 * Keeps the last MAX_FAILED_BACKGROUND_RESPONSES failed replies in `failed-background-responses.jsonl` next to
 * the sessions (which already hold the whole conversation, so this adds no new exposure). Only failures are
 * written, never every call. Never throws: a logging problem must not turn one failed pass into two.
 */
export function recordBackgroundFailure(entry: BackgroundFailureEntry): void {
	try {
		const path = failureLogPath();
		mkdirSync(dirname(path), { recursive: true });
		const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
		const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
		if (existing.length < MAX_FAILED_BACKGROUND_RESPONSES) {
			appendFileSync(path, `${line}\n`);
			return;
		}
		writeFileSync(path, `${[...existing, line].slice(-MAX_FAILED_BACKGROUND_RESPONSES).join("\n")}\n`);
	} catch (error) {
		console.error("Background failure log write failed:", error instanceof Error ? error.message : error);
	}
}
