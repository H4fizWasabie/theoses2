import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const workingNoteSchema = Type.Object({
	note: Type.Optional(
		Type.String({
			description:
				"One fact or line to append to the Working Note (not a replacement — earlier lines are kept, oldest dropped only once the note exceeds its cap)",
		}),
	),
	clear: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to clear the Working Note early, before its task is done (e.g. abandoning an approach). The harness already clears it automatically once the current operation finishes, so this is only for clearing mid-operation. Omit `note` when clearing.",
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
			"Append one concise established fact, path, or open discrepancy to the current operation's Working Note — a scratchpad for things this operation must not re-discover. " +
			"It is cleared automatically by the harness once the operation completes, so it does not need to be cleared manually except to abandon it early (see `clear`).",
		promptSnippet: "Append to or clear the bounded Working Note",
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
