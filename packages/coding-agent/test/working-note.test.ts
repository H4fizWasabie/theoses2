import { describe, expect, it } from "vitest";
import { limitActiveContextMessages, SessionManager } from "../src/core/session-manager.ts";
import { createWorkingNoteToolDefinition } from "../src/core/tools/working-note.ts";
import {
	appendWorkingNote,
	clearWorkingNote,
	finishWorkingNoteOperation,
	recordWorkingNoteCommand,
	WORKING_NOTE_INJECTION_CAP,
	WORKING_NOTE_STALE_TURNS,
	WORKING_NOTE_WRITE_CAP,
	workingNoteForPrompt,
} from "../src/core/working-note.ts";

function addUserTurns(manager: SessionManager, count: number): void {
	for (let i = 0; i < count; i++) {
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `turn ${i}` }],
			timestamp: Date.now() + i,
		});
	}
}

describe("Theoses2 Working Note", () => {
	it("persists the latest bounded note as a session-log entry", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "x".repeat(WORKING_NOTE_WRITE_CAP + 1));

		expect(manager.getWorkingNote()).toHaveLength(WORKING_NOTE_WRITE_CAP);
		expect(manager.getBranch().at(-1)?.type).toBe("working_note");
	});

	it("appends rather than replaces across multiple calls (issue #173)", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "fact one");
		appendWorkingNote(manager, "fact two");

		expect(manager.getWorkingNote()).toBe("fact one\nfact two");
	});

	it("drops the oldest whole lines once the combined note exceeds the cap", () => {
		const manager = SessionManager.inMemory();
		const line = "x".repeat(Math.floor(WORKING_NOTE_WRITE_CAP / 2));
		appendWorkingNote(manager, `first ${line}`);
		appendWorkingNote(manager, `second ${line}`);
		appendWorkingNote(manager, `third ${line}`);

		const note = manager.getWorkingNote();
		expect(note.length).toBeLessThanOrEqual(WORKING_NOTE_WRITE_CAP);
		expect(note).not.toContain("first");
		expect(note).toContain("third");
	});

	it("drops logged commands before facts the model wrote", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "fact: the config lives in ~/.theoses");
		for (let i = 0; i < 40; i++) recordWorkingNoteCommand(manager, `run-step-${i} ${"x".repeat(80)}`, false);

		const lines = manager.getWorkingNote().split("\n");
		expect(manager.getWorkingNote().length).toBeLessThanOrEqual(WORKING_NOTE_WRITE_CAP);
		expect(lines[0]).toBe("fact: the config lives in ~/.theoses");
		expect(lines.at(-1)).toContain("run-step-39");
		expect(lines.some((line) => line.includes("run-step-0 "))).toBe(false);
	});

	it("logs a command with a failure mark, cut to its cap", () => {
		const manager = SessionManager.inMemory();
		recordWorkingNoteCommand(manager, "npm test", true);
		recordWorkingNoteCommand(manager, `echo ${"y".repeat(300)}`, false);
		recordWorkingNoteCommand(manager, "   ", false);

		const [failed, long, ...rest] = manager.getWorkingNote().split("\n");
		expect(failed).toBe("ran: npm test (failed)");
		expect(long).toBe(`ran: echo ${"y".repeat(195)}…`);
		expect(rest).toEqual([]);
	});

	it("keeps a multi-line command on one ran: line, so it is dropped and replaced as one", () => {
		const manager = SessionManager.inMemory();
		const heredoc = "python3 - <<'EOF'\nprint('hi')\nEOF";
		recordWorkingNoteCommand(manager, heredoc, true);
		appendWorkingNote(manager, "fact: python3 is 3.12");
		recordWorkingNoteCommand(manager, heredoc, false);

		expect(manager.getWorkingNote()).toBe("fact: python3 is 3.12\nran: python3 - <<'EOF'\\nprint('hi')\\nEOF");
	});

	it("moves a command run again to the end, with its latest result", () => {
		const manager = SessionManager.inMemory();
		recordWorkingNoteCommand(manager, "npm test", true);
		appendWorkingNote(manager, "fact: the failing test is auth.test.ts");
		recordWorkingNoteCommand(manager, "npm test", false);

		expect(manager.getWorkingNote()).toBe("fact: the failing test is auth.test.ts\nran: npm test");
	});

	it("clears the note when an operation completes, and keeps it when one aborts or fails", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "tracking task A");

		finishWorkingNoteOperation(manager, "aborted");
		finishWorkingNoteOperation(manager, "failed");
		expect(manager.getWorkingNote()).toBe("tracking task A");

		finishWorkingNoteOperation(manager, "completed");
		expect(manager.getWorkingNote()).toBe("");
	});

	it("clears a note left untouched past the stale-turn threshold when an operation does not complete", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "tracking task A");
		addUserTurns(manager, WORKING_NOTE_STALE_TURNS);
		finishWorkingNoteOperation(manager, "aborted");
		expect(manager.getWorkingNote()).toBe("tracking task A");

		addUserTurns(manager, 1);
		finishWorkingNoteOperation(manager, "aborted");
		expect(manager.getWorkingNote()).toBe("");
	});

	it("resets staleness once the note is written", () => {
		const manager = SessionManager.inMemory();
		appendWorkingNote(manager, "tracking task A");
		addUserTurns(manager, WORKING_NOTE_STALE_TURNS + 1);
		appendWorkingNote(manager, "tracking task B");

		finishWorkingNoteOperation(manager, "failed");
		expect(manager.getWorkingNote()).toBe("tracking task A\ntracking task B");
	});

	it("shows head and tail of a note over the injection cap", () => {
		expect(workingNoteForPrompt("short")).toBe("short");
		const shown = workingNoteForPrompt(`${"a".repeat(WORKING_NOTE_INJECTION_CAP)}${"b".repeat(10)}`);
		expect(shown.startsWith("a".repeat(WORKING_NOTE_INJECTION_CAP / 2))).toBe(true);
		expect(shown).toContain("\n...\n");
		expect(shown.endsWith("b".repeat(10))).toBe(true);
	});

	it("tool calls write on note and clear on clear:true", async () => {
		const manager = SessionManager.inMemory();
		const tool = createWorkingNoteToolDefinition(
			(note) => appendWorkingNote(manager, note),
			() => clearWorkingNote(manager),
		);

		await tool.execute("call-1", { note: "task A is in progress" }, undefined, undefined, {} as never);
		expect(manager.getWorkingNote()).toBe("task A is in progress");

		await tool.execute("call-2", { clear: true }, undefined, undefined, {} as never);
		expect(manager.getWorkingNote()).toBe("");
	});

	it("tool asks for note or clear when called with neither", async () => {
		const tool = createWorkingNoteToolDefinition(
			() => {},
			() => {},
		);

		const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("clear") });
	});

	it("keeps the last three user turns and their responses", () => {
		const messages = Array.from({ length: 6 }, (_, index) => [
			{ role: "user", content: `user-${index}` },
			{ role: "assistant", content: [{ type: "text", text: `assistant-${index}` }] },
		]).flat();

		const active = limitActiveContextMessages(messages as never[]);
		expect(active).toHaveLength(6);
		expect(active[0]).toMatchObject({ content: "user-3" });
	});

	it("uses the resolved channel key and keeps the documented caps", () => {
		const manager = SessionManager.inMemory();
		manager.newSession({ channel: "telegram", channelSessionId: "chat-1" });

		expect(manager.getChannelSessionKey()).toEqual({ channel: "telegram", channelSessionId: "chat-1" });
		expect(WORKING_NOTE_WRITE_CAP).toBe(2000);
		expect(WORKING_NOTE_INJECTION_CAP).toBe(2000);
	});
});
