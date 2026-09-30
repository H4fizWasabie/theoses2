/**
 * The lines around an edit, as the file reads after it. Without them a model that wants to know whether its edit landed
 * reads the file back, often the whole file or several chunks of it (a scraper build in production made 45 reads, roughly
 * a third of them checking edits it had just made). The tool result carries the answer instead.
 */
import * as Diff from "diff";

const CONTEXT_LINES = 2;
const MAX_LINES = 24;
const MAX_LINE_CHARS = 200;

/** Numbered lines (`line`, tab, text) of `newContent` around every change from `oldContent`, or "" when nothing changed. */
export function changedSnippet(oldContent: string, newContent: string): string {
	const lines = newContent.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return "";

	const changed: Array<[number, number]> = [];
	let line = 1;
	for (const part of Diff.diffLines(oldContent, newContent)) {
		const count = part.count ?? 0;
		if (part.added) {
			changed.push([line, line + count - 1]);
			line += count;
		} else if (part.removed) {
			// Nothing of it is left in the new file; point at the line that now sits where it was.
			changed.push([line, line]);
		} else {
			line += count;
		}
	}

	const ranges: Array<[number, number]> = [];
	for (const [from, to] of changed) {
		const start = Math.max(1, from - CONTEXT_LINES);
		const end = Math.min(lines.length, to + CONTEXT_LINES);
		const last = ranges.at(-1);
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else ranges.push([start, end]);
	}

	const shown: string[] = [];
	let shownLines = 0;
	let left = 0;
	for (const [start, end] of ranges) {
		if (shown.length > 0) shown.push("...");
		for (let n = start; n <= end; n++) {
			if (shownLines >= MAX_LINES) {
				left++;
				continue;
			}
			const text = lines[n - 1];
			shown.push(
				`${n}\t${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} [line truncated]` : text}`,
			);
			shownLines++;
		}
	}
	if (left > 0) shown.push(`(${left} more lines not shown)`);
	return shown.join("\n");
}
