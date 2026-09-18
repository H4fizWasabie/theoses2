/**
 * Thin client for TypeSafe's Jev "System One" model, called via OpenRouter's decisions endpoint
 * (see task-boundary-detector.ts and memory-consolidation.ts for its two call sites). Not modeled
 * as a `Model<Api>` in packages/ai: Jev's request/response shape (typed `state` + `questions` ->
 * typed `answers`) shares nothing with the streaming chat-completion shape every other provider in
 * packages/ai implements, and OpenRouter gates it behind a dedicated /api/alpha/decisions endpoint
 * rather than /chat/completions — confirmed live: the plain chat-completions path either 404s
 * ("No endpoints found that support tool use") or 500s on every request shape tried, since this
 * model was never meant to be called that way.
 */
const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL = "~typesafe/jev-latest";
/** Default per-request ceiling. Jev answers in ~100-500ms, so anything near this is a stalled
 * connection; without a cap a trickling or hung response would pin the caller (and the in-flight
 * guards some callers hold) indefinitely. */
export const JEV_DEFAULT_TIMEOUT_MS = 5000;

export interface JevCallOptions {
	/** Aborts the underlying request (not just the caller's wait) after this many ms. */
	timeoutMs?: number;
}

interface JevAnswer {
	noul?: number;
	choice?: string;
	confidence?: number;
}

interface JevResponse {
	answers?: Record<string, JevAnswer | undefined>;
}

/** Posts a set of named questions to the Jev decisions endpoint and returns the parsed JSON body,
 * or undefined on any failure (missing API key, network error, timeout, non-2xx response, malformed
 * body) — the single failure path shared by askJevNoul, askJevNouls and askJevChoice. Questions in
 * one request are evaluated in parallel by Jev, so several atomic questions cost one round trip. */
async function askJev(
	state: Record<string, string>,
	questions: Record<string, Record<string, unknown>>,
	options: JevCallOptions = {},
): Promise<JevResponse | undefined> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return undefined;

	const body = { model: JEV_MODEL, state, questions };

	try {
		const response = await fetch(JEV_DECISIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) {
			console.error(`Jev call failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
			return undefined;
		}
		return (await response.json()) as JevResponse;
	} catch (error) {
		console.error("Jev call failed:", error instanceof Error ? error.message : error);
		return undefined;
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
	state: Record<string, string>,
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
	state: Record<string, string>,
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

export interface JevChoiceResult {
	choice: string;
	/** 0-1, how concentrated Jev's probability mass was on `choice` — low values mean the
	 * category was ambiguous and callers should prefer their own fallback over trusting it. */
	confidence: number;
}

/**
 * Asks Jev to pick one of `criteria`'s keys for `state`. `criteria` maps each option name to a
 * short description of what it covers (same shape TypeSafe's Choice primitive expects). Returns
 * undefined on any failure, or if the returned choice isn't one of the keys offered — same
 * "skip this decision for now" contract as askJevNoul.
 */
export async function askJevChoice(
	state: Record<string, string>,
	instructions: string,
	criteria: Record<string, string>,
	options?: JevCallOptions,
): Promise<JevChoiceResult | undefined> {
	const parsed = await askJev(state, { answer: { type: "choice", instructions, criteria } }, options);
	const answer = parsed?.answers?.answer;
	if (typeof answer?.choice !== "string" || typeof answer?.confidence !== "number") return undefined;
	if (!(answer.choice in criteria)) return undefined;
	return { choice: answer.choice, confidence: answer.confidence };
}
