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

interface JevNoulResponse {
	answers?: { answer?: { noul?: number } };
}

interface JevChoiceResponse {
	answers?: { answer?: { choice?: string; confidence?: number } };
}

/** Posts one `questions.answer` request to the Jev decisions endpoint and returns its parsed JSON
 * body, or undefined on any failure (missing API key, network error, non-2xx response, malformed
 * body) — the single failure path shared by askJevNoul and askJevChoice. */
async function askJev<T>(state: Record<string, string>, question: Record<string, unknown>): Promise<T | undefined> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return undefined;

	const body = { model: JEV_MODEL, state, questions: { answer: question } };

	try {
		const response = await fetch(JEV_DECISIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			console.error(`Jev call failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
			return undefined;
		}
		return (await response.json()) as T;
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
export async function askJevNoul(state: Record<string, string>, instructions: string): Promise<number | undefined> {
	const parsed = await askJev<JevNoulResponse>(state, { type: "noul", instructions });
	const noul = parsed?.answers?.answer?.noul;
	return typeof noul === "number" ? noul : undefined;
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
): Promise<JevChoiceResult | undefined> {
	const parsed = await askJev<JevChoiceResponse>(state, { type: "choice", instructions, criteria });
	const answer = parsed?.answers?.answer;
	if (typeof answer?.choice !== "string" || typeof answer?.confidence !== "number") return undefined;
	if (!(answer.choice in criteria)) return undefined;
	return { choice: answer.choice, confidence: answer.confidence };
}
