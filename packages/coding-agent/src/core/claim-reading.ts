/**
 * Claim reading: the values a reply states. Two modes over one reading.
 *   cited: a value followed by a `⟨tN⟩` Citation is matched literally against the full text of output tN, which must
 *     be in the Task: Grounded if it shows the value, a Contradiction if not.
 *   scan: every other value is Grounded if any tool result of the same Task shows it literally, otherwise a Guess.
 *     A Citation to an id outside the Task is no Citation, so its value is read in scan mode. One pure function, no model call. The stop-time checker, the reply footer and the
 * offline eval all call it, so none of them can disagree about what counts as Grounded.
 *
 * A value is a number, path or URL in the reply. Literal matching is intentional: a count the model did in its head
 * is a Guess even when right, which pushes counting into a tool (`wc -l`). Not counted: values the owner typed,
 * dates, times, list ordinals, versions and years.
 *
 * The caller scopes the input: pass only the Task's messages up to the reply, so earlier Tasks and later results
 * cannot ground it. Tool outputs are read in full from these messages, never from a pruned context.
 */
import type { AgentMessage } from "theoses-agent-core";
import type { AssistantMessage } from "theoses-ai";
import { textOf, toolRuns } from "./tool-runs.ts";

export type ClaimStatus = "grounded" | "guess" | "contradiction";

/**
 * `small` is an integer of one or two digits: such a value shows up by coincidence in almost any long tool output
 * ("15" in "Oct 15 23:43"), so its Grounded status is untrusted. Everything else (3+ digits, a decimal, a path, a URL)
 * is `specific`. Headline Grounded share and Guess counts use specific Claims only.
 */
export type ClaimSpecificity = "specific" | "small";

export interface Claim {
	readonly value: string;
	readonly status: ClaimStatus;
	readonly specificity: ClaimSpecificity;
	/** Id of the first tool result of the Task that shows the value (Grounded only). */
	readonly source?: string;
	/** The `N` of the `⟨tN⟩` Citation the Claim was checked against (Grounded or Contradiction). */
	readonly cited?: number;
	/** What the cited output shows, abridged (Contradiction only). */
	readonly shown?: string;
}

/** Marker after a claimed value. Blanked before values are read so its own digit is not one. */
const CITATION = /⟨t(\d+)⟩/g;
const CITED_VALUE = /([^\s⟨]+)[ \t]*⟨t(\d+)⟩/g;
const SHOWN_LINES = 3;
const SHOWN_CHARS = 240;

const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;
const PATH_PATTERN = /(?<![\w./:-])(?:\.{1,2}\/|~\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+/g;
// Preceded by an uppercase letter is fine ("RM579.20" is 579.20); preceded by a digit, dot or comma it is part of a bigger number.
const NUMBER_PATTERN = /(?<![\d.,])\d+(?:[.,]\d+)*(?!\w)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
/** Not claims: dates, times, month-days, versions, years, list ordinals. Blanked before numbers are read. */
const IGNORED_PATTERNS = [
	/\b\d{4}-\d{1,2}-\d{1,2}\b/g,
	/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
	/\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
	new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
	new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "gi"),
	/(?<![\w.])v?\d+(?:\.\d+){2,}\b/g,
	/(?<=[a-z-])\d+(?:\.\d+)+\b/g,
	/\b(?:19|20)\d{2}\b/g,
	/^[ \t]*\d+[.)](?=\s)/gm,
];

function blankOut(match: string): string {
	return " ".repeat(match.length);
}

/**
 * A slash-joined word pair is a path only when it looks like one: rooted, dotted with an extension, or three or more
 * segments. "posts/day", "pass/fail" and "A/B" are prose.
 */
// ponytail: a path of two plain segments with no extension ("tests/box") is not a value; add the case if it shows up as a miss.
function isPathLike(match: string): boolean {
	if (!/[A-Za-z]/.test(match)) return false;
	if (/^(?:~|\.{1,2})?\//.test(match)) return true;
	if (/\.[A-Za-z0-9]+(?:\/|$)/.test(match)) return true;
	return (match.match(/\//g) ?? []).length >= 2;
}

/** The distinct values a text states, in order of appearance. */
function valuesIn(text: string): string[] {
	const values: string[] = [];
	const urls = text.replace(URL_PATTERN, (match) => {
		values.push(match.replace(TRAILING_PUNCTUATION, ""));
		return blankOut(match);
	});
	const paths = urls.replace(PATH_PATTERN, (match) => {
		if (!isPathLike(match)) return match;
		values.push(match.replace(TRAILING_PUNCTUATION, ""));
		return blankOut(match);
	});
	let rest = paths;
	for (const pattern of IGNORED_PATTERNS) rest = rest.replace(pattern, blankOut);
	for (const match of rest.matchAll(NUMBER_PATTERN)) values.push(match[0]);
	return [...new Set(values)];
}

function appearsIn(output: string, value: string): boolean {
	if (!/^\d/.test(value)) return output.includes(value);
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\d.,])${escaped}(?!\\w)`).test(output);
}

/**
 * Reads the Claims of `reply`. `taskMessages` are the messages of the reply's Task up to the reply; `ownerText` is
 * the owner's text in that Task, whose values are not counted. Returns one Claim per distinct value.
 */
export function readClaims(taskMessages: AgentMessage[], reply: AssistantMessage, ownerText = ""): Claim[] {
	const owned = new Set(valuesIn(ownerText));
	const outputs = toolRuns(taskMessages);
	const text = textOf(reply.content);
	const citations = new Map<string, number[]>();
	for (const [, token, id] of text.matchAll(CITED_VALUE)) {
		const value = valuesIn(token).at(-1);
		if (value !== undefined) citations.set(value, [...(citations.get(value) ?? []), Number(id)]);
	}
	return valuesIn(text.replace(CITATION, blankOut))
		.filter((value) => !owned.has(value))
		.map((value): Claim => {
			const specificity: ClaimSpecificity = /^\d{1,2}$/.test(value) ? "small" : "specific";
			const cited = (citations.get(value) ?? []).flatMap((id) => {
				const run = outputs.find((candidate) => candidate.outputId === id);
				return run ? [{ id, run }] : [];
			});
			if (cited.length > 0) {
				const match = cited.find(({ run }) => appearsIn(run.output, value)) ?? cited[0];
				if (appearsIn(match.run.output, value)) {
					return { value, status: "grounded", specificity, source: match.run.id, cited: match.id };
				}
				return { value, status: "contradiction", specificity, cited: match.id, shown: abridge(match.run.output) };
			}
			const source = outputs.find((run) => appearsIn(run.output, value));
			return source
				? { value, status: "grounded", specificity, source: source.id }
				: { value, status: "guess", specificity };
		});
}

function abridge(output: string): string {
	const head = output.trim().split("\n").slice(0, SHOWN_LINES).join(" | ");
	return head.length > SHOWN_CHARS ? `${head.slice(0, SHOWN_CHARS)}…` : head;
}

/** A run's final reply, by status. */
export interface ClaimSummary {
	grounded: Claim[];
	guesses: Claim[];
	/** Contradictions that survived the push-back. */
	contradictions: Claim[];
}

/** Undefined for a reply with no Claims, so channels render nothing. */
export function summarizeClaims(claims: Claim[]): ClaimSummary | undefined {
	if (claims.length === 0) return undefined;
	const by = (status: ClaimStatus) => claims.filter((claim) => claim.status === status);
	return { grounded: by("grounded"), guesses: by("guess"), contradictions: by("contradiction") };
}
