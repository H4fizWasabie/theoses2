import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryStore } from "../memory-store.ts";

const rememberSchema = Type.Object({ query: Type.String({ description: "What durable information to recall" }) });
const saveNoteSchema = Type.Object({
	note: Type.String({ description: "A durable fact or preference explicitly requested by the user" }),
});

type RememberInput = Static<typeof rememberSchema>;
type SaveNoteInput = Static<typeof saveNoteSchema>;

export function createMemoryToolDefinitions(store: MemoryStore): ToolDefinition[] {
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
			description: "Save a durable fact or preference when the user explicitly asks you to remember it.",
			promptSnippet: "Save an explicitly requested durable note",
			parameters: saveNoteSchema,
			execute: async (_id, { note }: SaveNoteInput) => {
				store.saveNote(note);
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
