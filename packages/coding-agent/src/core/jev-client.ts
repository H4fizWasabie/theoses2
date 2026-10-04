/**
 * Thin client for TypeSafe's Jev "System One" model, called via OpenRouter's decisions endpoint
 * (callers: task-boundary-detector.ts, memory-consolidation.ts, memory-relevance.ts, memory-gate.ts). Not modeled as a `Model<Api>` in packages/ai:
 * Jev's request/response shape (typed `state` + `questions` -> typed `answers`) shares nothing with
 * the streaming chat-completion shape every other provider in packages/ai implements, and OpenRouter
 * gates it behind a dedicated /api/alpha/decisions endpoint rather than /chat/completions — confirmed
 * live: the plain chat-completions path either 404s ("No endpoints found that support tool use") or
 * 500s on every request shape tried, since this model was never meant to be called that way.
 *
 * Jev calls never go through the agent loop (they're fire-and-forget from internal detectors, not
 * tool calls), so they never land in a session .jsonl the way model usage does. Cost is instead
 * appended to its own log (see logJevCost) so a nightly report can total it independently.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL = "~typesafe/jev-latest";
/** Default per-request ceiling. Jev answers in ~100-500ms, so anything near this is a stalled
 * connection; without a cap a trickling or hung response would pin the caller (and the in-flight
 * guards some callers hold) indefinitely. */
export const JEV_DEFAULT_TIMEOUT_MS = 5000;

export interface JevCallOptions {
	/** Aborts the underlying request (not just the caller's wait) after this many ms. */
	timeoutMs?: number;
	/** Names the call site in failure logs ("task-boundary", "memory-gate", ...). Without it a bare
	 * "aborted due to timeout" cannot be traced to one of the five callers. */
	label?: string;
	/** Fresh requests to send after a timeout, for callers that can wait (Turn Settlement). Jev answers in
	 * well under 2s (p50 300ms, max 1.4s over 20 calls from production on 2026-10-04) or not at all: about 8%
	 * of settlement calls stalled to the 5s cap, so a new request helps where a longer wait would not. */
	retries?: number;
}

/** What Jev judges: any JSON object. Questions can point into nested fields by path, e.g. `nodes.n3`. */
export type JevState = Record<string, unknown>;

interface JevAnswer {
	noul?: number;
	choice?: string;
	confidence?: number;
}

interface JevResponse {
	answers?: Record<string, JevAnswer | undefined>;
	usage?: { cost?: number };
}

/** Resolved at call time, not import time, so the log follows the active agent dir (and any
 * test that stubs it) rather than whichever directory happened to be current at module load. */
function jevUsageLogPath(): string {
	return join(getAgentDir(), "jev-usage.jsonl");
}

/** Appends one line per Jev call so a report can total spend across all call sites without a
 * session to attach it to. Never throws: a logging failure must not affect the caller's answer. */
function logJevCost(cost: number, label: string | undefined): void {
	try {
		appendFileSync(jevUsageLogPath(), `${JSON.stringify({ timestamp: Date.now(), cost, label: label ?? null })}\n`);
	} catch {
		// Best-effort logging only.
	}
}

/** Posts a set of named questions to the Jev decisions endpoint and returns the parsed JSON body,
 * or undefined on any failure (missing API key, network error, timeout, non-2xx response, malformed
 * body) — the single failure path shared by askJevNoul and askJevNouls. Questions in one request
 * are evaluated in parallel by Jev, so several atomic questions cost one round trip. */
async function askJev(
	state: JevState,
	questions: Record<string, Record<string, unknown>>,
	options: JevCallOptions = {},
): Promise<JevResponse | undefined> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return undefined;

	const body = { model: JEV_MODEL, state, questions };
	const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? 0;
	for (let attempt = 0; ; attempt++) {
		const startedAt = performance.now();
		const describe = () =>
			`[${options.label ?? "unlabeled"}] after ${Math.round(performance.now() - startedAt)}ms ` +
			`(timeout ${timeoutMs}ms, questions=${Object.keys(questions).join(",")}, state=${JSON.stringify(state).length} chars` +
			`${attempt > 0 ? `, retry ${attempt}` : ""})`;

		try {
			const response = await fetch(JEV_DECISIONS_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				// The body read can time out too; that must not turn an HTTP failure into a retry.
				const detail = await response.text().catch(() => "");
				console.error(`Jev call failed ${describe()}: ${response.status} ${detail.slice(0, 200)}`);
				return undefined;
			}
			const parsed = (await response.json()) as JevResponse;
			if (typeof parsed.usage?.cost === "number") logJevCost(parsed.usage.cost, options.label);
			return parsed;
		} catch (error) {
			console.error(`Jev call failed ${describe()}:`, error instanceof Error ? error.message : error);
			// Only a timeout is worth a new request; a network or parse error would fail the same way again.
			if (error instanceof Error && error.name === "TimeoutError" && attempt < retries) continue;
			return undefined;
		}
	}
}

/**
 * Asks Jev a single yes/no (Noul) question about `state`. Returns the raw probability (0 = no,
 * 1 = yes), or undefined on any failure. Every caller treats a missing answer as "skip this
 * decision for now" — Jev calls happen on a fire-and-forget per-turn cadence elsewhere in this
 * package, so a failure here is retried by construction on the next turn rather than needing its
 * own retry loop.
 */
export async function askJevNoul(
	state: JevState,
	instructions: string,
	options?: JevCallOptions,
): Promise<number | undefined> {
	const parsed = await askJev(state, { answer: { type: "noul", instructions } }, options);
	const noul = parsed?.answers?.answer?.noul;
	return typeof noul === "number" ? noul : undefined;
}

/**
 * Asks several independent yes/no (Noul) questions about the same `state` in ONE request (keyed by
 * name, evaluated in parallel by Jev). Per TypeSafe's guidance, atomic questions combined in code
 * beat one broad question: each signal is inspectable and code decides how to weigh them. Returns
 * a probability per name, or undefined if the call failed or ANY requested answer is missing (a
 * partial verdict would silently skew the caller's combination rule).
 */
export async function askJevNouls<K extends string>(
	state: JevState,
	questions: Record<K, string>,
	options?: JevCallOptions,
): Promise<Record<K, number> | undefined> {
	const names = Object.keys(questions) as K[];
	const request = Object.fromEntries(names.map((name) => [name, { type: "noul", instructions: questions[name] }]));
	const parsed = await askJev(state, request, options);
	const result = {} as Record<K, number>;
	for (const name of names) {
		const noul = parsed?.answers?.[name]?.noul;
		if (typeof noul !== "number") return undefined;
		result[name] = noul;
	}
	return result;
}
