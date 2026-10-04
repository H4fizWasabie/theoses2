import type { OperationFinishedEntry, SessionManager } from "./session-manager.ts";

/**
 * Working Note (CONTEXT.md): the rules for the note's content and lifecycle. SessionManager only stores it, as
 * `working_note` entries holding the whole note (ADR-0001); everything that decides what the note says lives here.
 */

export const WORKING_NOTE_WRITE_CAP = 2000;
export const WORKING_NOTE_INJECTION_CAP = 2000;
/**
 * Backstop for when the model forgets to clear the note itself: if this many user turns pass with no write or
 * clear touching it, it is treated as abandoned and cleared at the end of the next operation that does not complete.
 */
export const WORKING_NOTE_STALE_TURNS = 5;
/** Bounds one `ran:` line: the command, not its output (the how, not the what). */
const COMMAND_CAP = 200;
const RAN = "ran: ";
const FAILED = " (failed)";

type WorkingNoteStore = Pick<SessionManager, "getWorkingNote" | "writeWorkingNote" | "getBranch">;

/**
 * Over the cap, `ran:` lines go first (oldest first), so harness-logged commands never push out a fact the model
 * wrote; then the oldest other lines. A single line still over the cap is cut from its start.
 */
function capped(lines: string[]): string {
	let note = lines.join("\n");
	while (note.length > WORKING_NOTE_WRITE_CAP && lines.length > 1) {
		const ran = lines.findIndex((line) => line.startsWith(RAN));
		lines.splice(ran === -1 ? 0 : ran, 1);
		note = lines.join("\n");
	}
	return note.length > WORKING_NOTE_WRITE_CAP ? note.slice(note.length - WORKING_NOTE_WRITE_CAP) : note;
}

function linesOf(store: WorkingNoteStore): string[] {
	const note = store.getWorkingNote();
	return note ? note.split("\n") : [];
}

/** Appends one line (the `working_note` tool's write). */
export function appendWorkingNote(store: WorkingNoteStore, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) throw new Error("Working Note line cannot be empty");
	store.writeWorkingNote(capped([...linesOf(store), trimmed]));
}

/**
 * Logs one bash command, the model's or the owner's: `ran: <command>`, plus `(failed)` when it did not succeed. A
 * command run again replaces its earlier line, so the note keeps the latest result and its recency. A multi-line
 * command (a heredoc) is kept on one line, with its line breaks written as `\n`, so it stays one `ran:` line.
 */
export function recordWorkingNoteCommand(store: WorkingNoteStore, command: string, failed: boolean): void {
	const trimmed = command.trim().replace(/\r?\n/g, "\\n");
	if (!trimmed) return;
	const ran = `${RAN}${trimmed.length > COMMAND_CAP ? `${trimmed.slice(0, COMMAND_CAP)}…` : trimmed}`;
	const lines = linesOf(store).filter((line) => line !== ran && line !== `${ran}${FAILED}`);
	store.writeWorkingNote(capped([...lines, failed ? `${ran}${FAILED}` : ran]));
}

export function clearWorkingNote(store: WorkingNoteStore): void {
	store.writeWorkingNote("");
}

function isStale(store: WorkingNoteStore): boolean {
	const branch = store.getBranch();
	let boundary = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "working_note") {
			boundary = i + 1;
			break;
		}
	}
	let userTurns = 0;
	for (let i = boundary; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") userTurns++;
	}
	return userTurns > WORKING_NOTE_STALE_TURNS;
}

/**
 * The note is a scratchpad for the operation in progress, not a cross-operation memory (#173): a completed operation
 * clears it. An aborted or failed one leaves it for the next operation to pick up, unless it has gone stale.
 */
export function finishWorkingNoteOperation(store: WorkingNoteStore, outcome: OperationFinishedEntry["outcome"]): void {
	if (!store.getWorkingNote()) return;
	if (outcome === "completed" || isStale(store)) clearWorkingNote(store);
}

/** The note as the system prompt shows it: head and tail when it is over the injection cap. */
export function workingNoteForPrompt(note: string): string {
	if (note.length <= WORKING_NOTE_INJECTION_CAP) return note;
	const half = WORKING_NOTE_INJECTION_CAP / 2;
	return `${note.slice(0, half)}\n...\n${note.slice(-half)}`;
}
