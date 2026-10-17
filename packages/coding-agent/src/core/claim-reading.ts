/**
 * Claim reading, scan mode: the values a reply states, each Grounded if a tool result of the same Task shows it
 * literally, otherwise a Guess. One pure function, no model call. The stop-time checker, the reply footer and the
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

export type ClaimStatus = "grounded" | "guess";

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
}

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
	return valuesIn(textOf(reply.content))
		.filter((value) => !owned.has(value))
		.map((value): Claim => {
			const source = outputs.find((run) => appearsIn(run.output, value));
			const specificity: ClaimSpecificity = /^\d{1,2}$/.test(value) ? "small" : "specific";
			return source
				? { value, status: "grounded", specificity, source: source.id }
				: { value, status: "guess", specificity };
		});
}
