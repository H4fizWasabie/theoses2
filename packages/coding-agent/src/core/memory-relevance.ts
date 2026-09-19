/**
 * Relevance ranking for the `remember` tool.
 *
 * `FileMemoryStore.remember` is a keyword match plus a graph walk. It is fast and deterministic but has no idea
 * what a query means, so it hands the model results that only share a word with it: asked "who the user is", it
 * returned the orange portfolio variant, the ledger-paper design and a release bundle path. This module puts one
 * Jev request between the store and the model: a yes/no question per candidate ("is this node about the subject of
 * the query?"), then the candidates are ordered by that probability and the ones below a floor are dropped.
 *
 * Measured 2026-09-19 on 30 real `remember` queries from the production logs, 8 candidates each (240 pairs, labeled
 * by hand before Jev saw them): 72% of what was returned was relevant. Kept at 0.4 with this wording, precision was
 * 86% and 98% of the relevant nodes survived; ordering by the score alone lifted precision in the top 3 from 79%
 * to 94%. On the four "who is the user" queries, 9 of 32 results had been relevant. A stricter wording ("would this
 * node help answer or act on the query?") lost relevant nodes whenever a node was on topic but did not contain the
 * asked-for detail, so the question is deliberately about subject, not usefulness.
 *
 * Widening the pool from 8 to RELEVANCE_CANDIDATES (20) and showing the best 8 by score, on the same 30 queries:
 * 231 results shown, 208 relevant (90%) against 173 of 240 (72%) before, irrelevant results 67 -> 23, precision in
 * the top 3 79% -> 97%. No query showed fewer relevant results than before (17 showed more, 13 the same). The four
 * "who is the user" queries went from 1, 1, 4 and 3 relevant results to 2, 3, 8 and 8. A request with 20 questions
 * took a median 824ms (p95 1.1s) and cost about $0.00006. The extra candidates were labeled after Jev chose them,
 * so their precision (86%) is the softer number.
 *
 * Jev only ranks what the keyword search found; it cannot surface a node the search missed. Every failure path
 * (no API key, timeout, malformed answer, or every candidate scored under the floor) returns undefined, and the
 * caller falls back to the plain keyword results, so this can only change what is shown, never break `remember`.
 */

import { askJevNouls } from "./jev-client.ts";
import { type MemoryRecord, REMEMBER_RESULT_LIMIT } from "./memory-store.ts";

/** How many keyword-search candidates the `remember` tool asks the store for before ranking them. */
export const RELEVANCE_CANDIDATES = 20;
/** A candidate whose relevance probability is below this is not shown. */
export const RELEVANCE_MIN_NOUL = 0.4;
/** Jev calls happen inside a tool call the model is waiting on, so give up quickly and fall back. */
const RELEVANCE_TIMEOUT_MS = 4000;
/** Each node's text is cut to this length before it is sent (the test used the same cut). */
const NODE_TEXT_MAX_CHARS = 420;

/** On unless THEOSES_REMEMBER_RELEVANCE=off: the ranking sends memory text to Jev. */
export function isRememberRelevanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.THEOSES_REMEMBER_RELEVANCE !== "off";
}

/**
 * Orders `records` by Jev's relevance to `query`, drops those under RELEVANCE_MIN_NOUL and keeps at most `limit`.
 * Returns undefined when there is nothing trustworthy to return: no records, a failed or partial Jev answer, or
 * no record above the floor.
 */
export async function rankByRelevance(
	query: string,
	records: MemoryRecord[],
	limit: number = REMEMBER_RESULT_LIMIT,
): Promise<MemoryRecord[] | undefined> {
	if (records.length === 0) return undefined;

	const started = Date.now();
	const names = records.map((_, index) => `n${index}`);
	const state = {
		query,
		nodes: Object.fromEntries(
			records.map((record, index) => [names[index], record.text.slice(0, NODE_TEXT_MAX_CHARS)]),
		),
	};
	const questions = Object.fromEntries(
		names.map((name) => [name, `Is \`nodes.${name}\` about the subject of \`query\`?`]),
	);

	const scores = await askJevNouls(state, questions, { timeoutMs: RELEVANCE_TIMEOUT_MS });
	if (scores === undefined) return undefined;

	const kept = records
		.map((record, index) => ({ record, score: scores[names[index]] }))
		.filter((entry) => entry.score >= RELEVANCE_MIN_NOUL)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	if (process.env.THEOSES_DEBUG_REMEMBER) {
		console.error(
			`[remember] relevance: ${records.length} candidates, kept ${kept.length}, ${Date.now() - started}ms, top ${kept[0]?.score.toFixed(2) ?? "-"}`,
		);
	}
	return kept.length > 0 ? kept.map((entry) => entry.record) : undefined;
}
