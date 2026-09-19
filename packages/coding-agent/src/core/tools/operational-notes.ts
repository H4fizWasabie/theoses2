import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import { getOperationalNotesPath } from "../../config.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";

// operational-notes.md (issue #173): the middle tier between the ephemeral,
// per-operation Working Note and the permanent semantic-graph memory
// (save_note). Durable across operations and sessions, but cheap to write to
// and never auto-injected — a future operation reads it with `read` only
// when its topic overlaps, instead of paying its cost on every turn.

/** Caps the file so a runaway write loop can't wedge the read tool's default read window, mirroring the Working Note's own cap philosophy. */
export const OPERATIONAL_NOTES_MAX_BYTES = 32 * 1024;

/**
 * The file used to refuse writes once full and leave the model to trim it mid-task. On 2026-09-19 that
 * happened three times in one day (a manual trim freed only ~1KB, so it refilled at once). Now a write
 * that would push the file past the trigger mark first moves the oldest entries to the archive file until
 * the file is down to the target, so the write always fits. Archived entries are appended to
 * `operational-notes-archive.md` next to the notes file, never deleted.
 *
 * An LLM-judged "already covered by durable memory" pass was tried first and dropped: against the real
 * 32KB file that failed, Jev flagged 0 of 53 entries, because each entry is a dense multi-claim line
 * while durable memory holds one small fact per node.
 */
export const OPERATIONAL_NOTES_TRIGGER_BYTES = Math.floor(OPERATIONAL_NOTES_MAX_BYTES * 0.9);
export const OPERATIONAL_NOTES_TARGET_BYTES = Math.floor(OPERATIONAL_NOTES_MAX_BYTES * 0.5);
const ARCHIVE_FILE_NAME = "operational-notes-archive.md";

const operationalNoteSchema = Type.Object({
	section: Type.String({
		description: 'Section heading to file this under, e.g. "Recent Fixes", "Error Patterns", "System Status"',
	}),
	content: Type.String({ description: "One concise, durable operational line to add under that section" }),
});

export type OperationalNoteInput = Static<typeof operationalNoteSchema>;

async function readOperationalNotes(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

function formatEntry(content: string): string {
	const singleLine = content.replace(/\s*\n\s*/g, " ").trim();
	return `${new Date().toISOString().slice(0, 16).replace("T", " ")} | ${singleLine}`;
}

/** Appends a deduped, timestamped line under `## <section>` in the operational notes file. Returns false if that exact line already exists under that section. */
export async function appendOperationalNote(path: string, section: string, content: string): Promise<boolean> {
	const existing = await readOperationalNotes(path);
	const header = `## ${section}`;
	const entry = formatEntry(content);
	if (existing.includes(`- ${entry}`)) return false;

	let body = existing;
	if (!body.includes(header)) {
		body += `${body.endsWith("\n") || body === "" ? "" : "\n"}\n${header}\n`;
	}
	const lines = body.split("\n");
	const headerIndex = lines.lastIndexOf(header);
	let insertAt = lines.length;
	for (let i = headerIndex + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			insertAt = i;
			break;
		}
	}
	lines.splice(insertAt, 0, `- ${entry}`);
	body = lines.join("\n").trim();

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${body}\n`, "utf8");
	return true;
}

interface NoteEntry {
	/** Index of this entry's line in the file's line array. */
	lineIndex: number;
	section: string;
	line: string;
	/** "YYYY-MM-DD HH:MM" prefix written by appendOperationalNote; undefined for hand-written lines. */
	timestamp: string | undefined;
}

const ENTRY_PATTERN = /^- (?:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| )?/;

function parseEntries(lines: string[]): NoteEntry[] {
	const entries: NoteEntry[] = [];
	let section: string | undefined;
	lines.forEach((line, lineIndex) => {
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			return;
		}
		if (section === undefined) return;
		const match = ENTRY_PATTERN.exec(line);
		if (match) entries.push({ lineIndex, section, line, timestamp: match[1] });
	});
	return entries;
}

/** Oldest first; hand-written lines with no timestamp sort last so they are only archived as a last resort. */
function oldestFirst(entries: NoteEntry[]): NoteEntry[] {
	return [...entries].sort((a, b) => (a.timestamp ?? "9999").localeCompare(b.timestamp ?? "9999"));
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Frees space in the notes file so a line of `incomingBytes` fits under the cap: once the file plus the new
 * line passes the trigger mark, moves the oldest entries to the archive file until it is down to the target.
 * Returns how many entries were moved. The archive is written before the notes file is rewritten, so a crash
 * in between duplicates an entry instead of losing it.
 */
export async function makeRoomForNote(path: string, incomingBytes: number): Promise<number> {
	const content = await readOperationalNotes(path);
	let size = byteLength(content);
	if (size + incomingBytes <= OPERATIONAL_NOTES_TRIGGER_BYTES) return 0;

	const lines = content.split("\n");
	const entries = parseEntries(lines);
	const moved: NoteEntry[] = [];
	for (const entry of oldestFirst(entries)) {
		if (size + incomingBytes <= OPERATIONAL_NOTES_TARGET_BYTES) break;
		moved.push(entry);
		size -= byteLength(entry.line) + 1;
	}
	if (moved.length === 0) return 0;

	await appendToArchive(join(dirname(path), ARCHIVE_FILE_NAME), moved);

	const archivedLines = new Set(moved.map((entry) => entry.lineIndex));
	const kept = lines.filter((_, lineIndex) => !archivedLines.has(lineIndex));
	const stillHasEntries = new Set(parseEntries(kept).map((entry) => entry.section));
	const output = dropEmptiedSections(kept, new Set(moved.map((entry) => entry.section)), stillHasEntries);

	const temp = join(dirname(path), `.${basename(path)}.tmp`);
	await writeFile(temp, `${output.join("\n").trim()}\n`, "utf8");
	await rename(temp, path);
	return moved.length;
}

/** Removes a section heading whose entries were all archived; sections that were already empty are left as they were. */
function dropEmptiedSections(lines: string[], emptied: Set<string>, stillHasEntries: Set<string>): string[] {
	const output: string[] = [];
	for (const line of lines) {
		if (line.startsWith("## ")) {
			const section = line.slice(3).trim();
			if (emptied.has(section) && !stillHasEntries.has(section)) continue;
		}
		output.push(line);
	}
	return output;
}

async function appendToArchive(archivePath: string, moved: NoteEntry[]): Promise<void> {
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
	const blocks = [`# Archived ${stamp} (${moved.length} oldest)`];
	const bySection = new Map<string, string[]>();
	for (const entry of moved) bySection.set(entry.section, [...(bySection.get(entry.section) ?? []), entry.line]);
	for (const [section, sectionLines] of bySection) blocks.push(`## ${section}`, ...sectionLines);

	const existing = await readOperationalNotes(archivePath);
	const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	await mkdir(dirname(archivePath), { recursive: true });
	await writeFile(archivePath, `${existing}${separator}${blocks.join("\n")}\n`, "utf8");
}

/** Serializes writes per file: three parallel note_operations calls used to read the same snapshot and overwrite each other. */
const writeQueues = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, task: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(path) ?? Promise.resolve();
	const next = previous.then(task, task);
	writeQueues.set(
		path,
		next.catch(() => undefined),
	);
	return next;
}

export function createOperationalNotesToolDefinition(options?: {
	path?: string;
}): ToolDefinition<typeof operationalNoteSchema> {
	const path = options?.path ?? getOperationalNotesPath();

	return {
		name: "note_operations",
		label: "note_operations",
		description:
			"Add a durable, section-based line to operational-notes.md — for things learned running this system that outlive one operation but aren't yet worth a permanent save_note fact (e.g. an error pattern, a fix, a system quirk). " +
			"Unlike working_note, this is NOT auto-injected into context: a later operation must `read` it when its topic is relevant. Deduped and capped at 32KB — when it nears the cap, the oldest entries are moved to operational-notes-archive.md automatically, so you never need to trim it yourself.",
		promptSnippet: "Add a durable, section-based operational note",
		parameters: operationalNoteSchema,
		execute: (_toolCallId, { section, content }: OperationalNoteInput) =>
			serialized(path, async () => {
				try {
					let archivedNote = "";
					try {
						const moved = await makeRoomForNote(path, byteLength(`- ${formatEntry(content)}\n`));
						if (moved > 0)
							archivedNote = ` Moved the ${moved} oldest entries to ${ARCHIVE_FILE_NAME} to make room.`;
					} catch {
						// Archiving is best effort; the cap check below still protects the file.
					}
					const info = await stat(path).catch(() => undefined);
					if (info && info.size > OPERATIONAL_NOTES_MAX_BYTES) {
						return {
							content: [
								{
									type: "text" as const,
									text: `operational-notes.md is full (32KB cap) and could not be archived automatically. Promote durable items to save_note, then trim ${path}.`,
								},
							],
							details: undefined,
						};
					}
					const added = await appendOperationalNote(path, section, content);
					return {
						content: [
							{
								type: "text" as const,
								text: added
									? `Added to operational notes [${section}]: ${content} (${path}). Consult with read when a future operation touches this topic; promote durable items to save_note.${archivedNote}`
									: `operational-notes.md already contains [${section}]: ${content}`,
							},
						],
						details: undefined,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text" as const, text: `Failed to write operational note: ${message}` }],
						details: undefined,
					};
				}
			}),
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("note_operations")), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : "Added"), 0, 0),
	};
}
