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

/**
 * Asks Jev a single yes/no (Noul) question about `state`. Returns the raw probability (0 = no,
 * 1 = yes), or undefined on any failure (missing API key, network error, non-2xx response,
 * malformed body). Every caller treats a missing answer as "skip this decision for now" — Jev
 * calls happen on a fire-and-forget per-turn cadence elsewhere in this package, so a failure here
 * is retried by construction on the next turn rather than needing its own retry loop.
 */
export async function askJevNoul(state: Record<string, string>, instructions: string): Promise<number | undefined> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return undefined;

	const body = {
		model: JEV_MODEL,
		state,
		questions: { answer: { type: "noul", instructions } },
	};

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
		const parsed = (await response.json()) as JevNoulResponse;
		const noul = parsed.answers?.answer?.noul;
		return typeof noul === "number" ? noul : undefined;
	} catch (error) {
		console.error("Jev call failed:", error instanceof Error ? error.message : error);
		return undefined;
	}
}
