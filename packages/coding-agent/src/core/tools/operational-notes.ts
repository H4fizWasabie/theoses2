import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Appends a deduped, timestamped line under `## <section>` in the operational notes file. Returns false if that exact line already exists under that section. */
export async function appendOperationalNote(path: string, section: string, content: string): Promise<boolean> {
	const existing = await readOperationalNotes(path);
	const header = `## ${section}`;
	const entry = `${new Date().toISOString().slice(0, 16).replace("T", " ")} | ${content}`;
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

export function createOperationalNotesToolDefinition(options?: {
	path?: string;
}): ToolDefinition<typeof operationalNoteSchema> {
	const path = options?.path ?? getOperationalNotesPath();

	return {
		name: "note_operations",
		label: "note_operations",
		description:
			"Add a durable, section-based line to operational-notes.md — for things learned running this system that outlive one operation but aren't yet worth a permanent save_note fact (e.g. an error pattern, a fix, a system quirk). " +
			"Unlike working_note, this is NOT auto-injected into context: a later operation must `read` it when its topic is relevant. Deduped and capped at 32KB — once full, promote durable items to save_note and trim the file.",
		promptSnippet: "Add a durable, section-based operational note",
		parameters: operationalNoteSchema,
		execute: async (_toolCallId, { section, content }: OperationalNoteInput) => {
			try {
				const info = await stat(path).catch(() => undefined);
				if (info && info.size > OPERATIONAL_NOTES_MAX_BYTES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `operational-notes.md is full (32KB cap). Promote durable items to save_note, then trim ${path}.`,
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
								? `Added to operational notes [${section}]: ${content} (${path}). Consult with read when a future operation touches this topic; promote durable items to save_note.`
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
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("note_operations")), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : "Added"), 0, 0),
	};
}
