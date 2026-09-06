import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const workingNoteSchema = Type.Object({
	note: Type.Optional(
		Type.String({ description: "The complete replacement Working Note, capped at 2000 characters" }),
	),
	clear: Type.Optional(
		Type.Boolean({
			description:
				"Set to true once the task the Working Note was tracking is fully complete, to clear it before starting on something unrelated. Omit `note` when clearing.",
		}),
	),
});

export type WorkingNoteToolInput = Static<typeof workingNoteSchema>;

export function createWorkingNoteToolDefinition(
	write: (note: string) => void,
	clear: () => void,
): ToolDefinition<typeof workingNoteSchema> {
	return {
		name: "working_note",
		label: "working_note",
		description:
			"Replace the per-channel-session Working Note with concise established facts and open discrepancies. " +
			"Call with `clear: true` once the task it was tracking is fully complete (not while a clarifying question to the user is still outstanding), so unrelated context doesn't bleed into the next task.",
		promptSnippet: "Update or clear the bounded Working Note",
		parameters: workingNoteSchema,
		execute: async (_toolCallId, { note, clear: shouldClear }: WorkingNoteToolInput) => {
			if (shouldClear) {
				clear();
				return { content: [{ type: "text", text: "Working Note cleared." }], details: undefined };
			}
			if (note === undefined) {
				return {
					content: [{ type: "text", text: "Provide `note`, or set `clear: true` to clear the Working Note." }],
					details: undefined,
				};
			}
			write(note);
			return { content: [{ type: "text", text: "Working Note updated." }], details: undefined };
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("working_note")), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(
				theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : "Updated"),
				0,
				0,
			),
	};
}
