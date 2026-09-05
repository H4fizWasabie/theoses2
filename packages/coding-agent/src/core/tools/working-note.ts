import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const workingNoteSchema = Type.Object({
	note: Type.String({ description: "The complete replacement Working Note, capped at 2000 characters" }),
});

export type WorkingNoteToolInput = Static<typeof workingNoteSchema>;

export function createWorkingNoteToolDefinition(
	write: (note: string) => void,
): ToolDefinition<typeof workingNoteSchema> {
	return {
		name: "working_note",
		label: "working_note",
		description:
			"Replace the per-channel-session Working Note with concise established facts and open discrepancies.",
		promptSnippet: "Update the bounded Working Note for the next turn",
		parameters: workingNoteSchema,
		execute: async (_toolCallId, { note }: WorkingNoteToolInput) => {
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
