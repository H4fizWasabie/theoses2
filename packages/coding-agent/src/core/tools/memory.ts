import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GateVerdict } from "../memory-gate.ts";
import { type MemoryRecord, type MemoryStore, REMEMBER_RESULT_LIMIT } from "../memory-store.ts";

const rememberSchema = Type.Object({ query: Type.String({ description: "What durable information to recall" }) });
const saveNoteSchema = Type.Object({
	note: Type.String({ description: "A present, durable fact about the user, people, projects, or preferences" }),
});

type RememberInput = Static<typeof rememberSchema>;
type SaveNoteInput = Static<typeof saveNoteSchema>;

/** Optional second stage for `remember`: a wider keyword pool that `rank` orders and trims (see memory-relevance.ts). */
export interface RememberRelevanceOptions {
	/** How many candidates to ask the store for. */
	candidates: number;
	/** Returns the records to show, best first, or undefined to fall back to the plain keyword results. */
	rank: (query: string, records: MemoryRecord[]) => Promise<MemoryRecord[] | undefined>;
}

/** Optional check before `save_note` writes: skip a fact that is already stored, or replace a less detailed one. */
export interface SaveNoteGateOptions {
	check: (note: string) => Promise<GateVerdict>;
	/** Marks the stored node `oldId` as replaced by the new node `newId`. */
	supersede: (newId: string, oldId: string) => void;
}

export function createMemoryToolDefinitions(
	store: MemoryStore,
	onMemorySaved?: () => void,
	relevance?: RememberRelevanceOptions,
	saveGate?: SaveNoteGateOptions,
): ToolDefinition[] {
	return [
		{
			name: "remember",
			label: "remember",
			description:
				"Retrieve durable memory proactively whenever a question might depend on previously saved context about the user, their setup, or their projects - don't wait for them to explicitly ask you to recall something, and don't make them repeat context that's already saved.",
			promptSnippet: "Retrieve relevant durable memory proactively",
			parameters: rememberSchema,
			execute: async (_id, { query }: RememberInput) => {
				let records = store.remember(query, relevance?.candidates);
				if (relevance && records.length > 0) {
					const ranked = await relevance.rank(query, records);
					records = ranked ?? records.slice(0, REMEMBER_RESULT_LIMIT);
				}
				return {
					content: [
						{
							type: "text",
							text: records.map((record) => `- ${record.text}`).join("\n") || "No matching memory.",
						},
					],
					details: undefined,
				};
			},
			renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("remember")), 0, 0),
			renderResult: (result, _options, theme) =>
				new Text(
					theme.fg(
						"toolOutput",
						result.content[0]?.type === "text" ? result.content[0].text : "No matching memory.",
					),
					0,
					0,
				),
		},
		{
			name: "save_note",
			label: "save_note",
			description:
				"Save a present, durable fact worth remembering — a preference, a fact about a person/project/system, or a standing decision. This writes a bare entry immediately; a background pass links it into the memory graph and merges it with related facts later, so don't hold back on saving something because it isn't fully connected to context yet.",
			promptSnippet: "Save a durable fact to memory",
			parameters: saveNoteSchema,
			execute: async (_id, { note }: SaveNoteInput) => {
				const verdict: GateVerdict = saveGate ? await saveGate.check(note) : { action: "store" };
				if (verdict.action === "reuse") {
					return {
						content: [
							{ type: "text", text: `Already remembered, so nothing was saved: ${verdict.existing.subject}` },
						],
						details: undefined,
					};
				}
				const record = store.saveNote(note);
				let text = "Durable note saved.";
				if (verdict.action === "supersede" && saveGate) {
					saveGate.supersede(record.id, verdict.existing.id);
					text = `Durable note saved. It replaces a less detailed note: ${verdict.existing.subject}`;
				}
				onMemorySaved?.();
				return { content: [{ type: "text", text }], details: undefined };
			},
			renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("save_note")), 0, 0),
			renderResult: (result, _options, theme) =>
				new Text(
					theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : "Saved."),
					0,
					0,
				),
		},
	];
}
