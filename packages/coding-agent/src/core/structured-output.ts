import { parseJsonWithRepair } from "theoses-ai";

/**
 * Tolerant parsing for structured-output LLM calls (consolidation's facts/edges/episode object,
 * compaction distillation's facts array). Three layers, issue #250:
 *
 * 1. Standard parse after stripping markdown code fences (models sometimes wrap despite
 *    "no fences" instructions).
 * 2. Repair-and-retry for near-miss JSON: raw control characters / invalid escape sequences
 *    inside string literals (parseJsonWithRepair from the-ai), and trailing commas
 *    (string-aware scanner below — a naive regex `,\s*[}\]]` would also match inside string
 *    values, e.g. `"body": "hello ,}"`, silently editing data).
 * 3. Diagnostics: if all of that fails, log WHERE it failed and a snippet of the raw text.
 *    The pre-#250 behavior logged only V8's position ("... in JSON at position 3855") with the
 *    raw text discarded, which made the intermittent malformed-JSON production failures
 *    impossible to diagnose after the fact.
 *
 * Throws on total failure — callers keep their existing failure semantics (consolidation's
 * checkpoint stays put and retries the window later; distillation skips the pass).
 */

/** String-aware trailing-comma removal: `{"a": [1, 2,],}` → `{"a": [1, 2]}`. */
export function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		// Structural context only (outside strings): find the next non-whitespace character.
		if (char === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (j < text.length && (text[j] === "}" || text[j] === "]")) continue; // drop the comma
		}
		out += char;
	}
	return out;
}

export function parseStructuredJson(rawText: string, label: string): unknown {
	const cleaned = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	try {
		return JSON.parse(cleaned);
	} catch (firstError) {
		// Layer 2: repair near-misses instead of dropping the whole pass.
		const repaired = stripTrailingCommas(cleaned);
		try {
			return parseJsonWithRepair(repaired);
		} catch {
			// Layer 3: keep the evidence. Position + a snippet around it, truncated hard so a
			// multi-hundred-KB malformed response can't flood the journal.
			const position = (firstError as { message?: string }).message?.match(/position (\d+)/)?.[1];
			const pos = position !== undefined ? Number.parseInt(position, 10) : null;
			const snippet = pos !== null ? cleaned.slice(Math.max(0, pos - 120), pos + 120) : cleaned.slice(0, 240);
			console.warn(
				`${label} returned invalid JSON${pos !== null ? ` at position ${pos}` : ""} even after repair; ` +
					`raw text around the failure: ${JSON.stringify(snippet)}`,
			);
			throw firstError;
		}
	}
}
