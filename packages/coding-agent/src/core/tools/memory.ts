import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryStore } from "../memory-store.ts";

const rememberSchema = Type.Object({ query: Type.String({ description: "What durable information to recall" }) });
const saveNoteSchema = Type.Object({
	note: Type.String({ description: "A present, durable fact about the user, people, projects, or preferences" }),
});

type RememberInput = Static<typeof rememberSchema>;
type SaveNoteInput = Static<typeof saveNoteSchema>;

export function createMemoryToolDefinitions(store: MemoryStore, onMemorySaved?: () => void): ToolDefinition[] {
	return [
		{
			name: "remember",
			label: "remember",
			description: "Retrieve durable memory only when the user explicitly asks you to recall something.",
			promptSnippet: "Retrieve explicitly requested durable memory",
			parameters: rememberSchema,
			execute: async (_id, { query }: RememberInput) => {
				const records = store.remember(query);
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
				store.saveNote(note);
				onMemorySaved?.();
				return { content: [{ type: "text", text: "Durable note saved." }], details: undefined };
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
