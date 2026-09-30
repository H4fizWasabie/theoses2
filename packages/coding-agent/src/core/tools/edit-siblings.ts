/**
 * The sibling hint on a successful edit: where else in the project the text the edit replaced appears.
 *
 * A model that is told "this test fails" reads the test, fixes what it names, says "fixed", and stops. The same mistake in
 * the neighbouring files is never opened. Asking it to "look for siblings" in the prompt did not change that (prompt A/B,
 * issue #426), so the tool does the search a careful colleague would do with grep and puts the answer in the result.
 * It points, and says that fixing the other instances is part of the task: with a softer "fix it there too if you like" the
 * model saw the siblings in all three runs and still left them alone as unrequested work (hint A/B, #426). The model
 * still decides whether each place is the same mistake.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** A shorter fragment would match everywhere (`= 1`, `x`). */
const MIN_FRAGMENT_CHARS = 6;
const MAX_LISTED = 5;
const MAX_FILES_SCANNED = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_MS = 500;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "vendor", "target"]);
const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)(test|tests|__tests__)\/)/;

/**
 * The part of `oldText` that the edit actually changed, widened just enough to be searchable: the identifier and
 * bracket it touches, so a fix that only inserts an argument (`.sort()` to `.sort(byId)`) still yields `.sort()`.
 */
export function changedFragment(oldText: string, newText: string): string {
	let start = 0;
	while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
	let end = 0;
	while (
		end < oldText.length - start &&
		end < newText.length - start &&
		oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]
	) {
		end++;
	}
	if (start === oldText.length && start === newText.length) return "";
	const before = oldText.slice(0, start).match(/[\w.$]*\(?$/)?.[0] ?? "";
	const middle = oldText.slice(start, oldText.length - end);
	const after = oldText.slice(oldText.length - end).match(/^\)?[\w.$]*/)?.[0] ?? "";
	return `${before}${middle}${after}`;
}

async function* sourceFiles(root: string, deadline: number): AsyncGenerator<string> {
	const pending = [root];
	let scanned = 0;
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
			} else if (entry.isFile() && !TEST_FILE.test(relative(root, path))) {
				if (++scanned > MAX_FILES_SCANNED || Date.now() > deadline) return;
				yield path;
			}
		}
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		if ((await stat(path)).size > MAX_FILE_BYTES) return undefined;
		const text = await readFile(path, "utf8");
		return text.slice(0, 8000).includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

/** `path:line` of each file other than `editedPath` that contains `fragment`, in scan order. Never throws: a hint that fails is no hint. */
async function findHits(cwd: string, editedPath: string, fragment: string): Promise<string[]> {
	const places: string[] = [];
	// A file outside the working directory has no project around it to search.
	if (relative(cwd, editedPath).startsWith("..")) return places;
	try {
		for await (const path of sourceFiles(cwd, Date.now() + MAX_SCAN_MS)) {
			if (path === editedPath) continue;
			const text = await readText(path);
			const index = text?.indexOf(fragment) ?? -1;
			if (text === undefined || index < 0) continue;
			const line = text.slice(0, index).split("\n").length;
			places.push(`${relative(cwd, path)}:${line}`);
		}
	} catch {
		// ignored
	}
	return places;
}

/** The note to append to a successful edit's result, or "" when there is nothing to point at. */
export async function siblingHint(
	cwd: string,
	editedPath: string,
	edits: Array<{ oldText: string; newText: string }>,
): Promise<string> {
	const notes: string[] = [];
	const seen = new Set<string>();
	for (const edit of edits) {
		const fragment = changedFragment(edit.oldText, edit.newText);
		if (fragment.trim().length < MIN_FRAGMENT_CHARS || seen.has(fragment)) continue;
		seen.add(fragment);
		const places = await findHits(cwd, editedPath, fragment);
		if (places.length === 0) continue;
		const listed = places.slice(0, MAX_LISTED).join(", ");
		const more = places.length > MAX_LISTED ? ` and ${places.length - MAX_LISTED} more` : "";
		notes.push(
			`Note: the text you replaced (${JSON.stringify(fragment)}) also appears in ${listed}${more}. Other instances of the same mistake are part of this bug, not extra work: open each one, fix it if it is the same mistake, and re-run the checks. Skip a place only if it is not the same mistake.`,
		);
	}
	return notes.length > 0 ? `\n${notes.join("\n")}` : "";
}
