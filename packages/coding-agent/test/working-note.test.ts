import { describe, expect, it } from "vitest";
import {
	limitActiveContextMessages,
	SessionManager,
	WORKING_NOTE_INJECTION_CAP,
	WORKING_NOTE_STALE_TURNS,
	WORKING_NOTE_WRITE_CAP,
} from "../src/core/session-manager.ts";
import { createWorkingNoteToolDefinition } from "../src/core/tools/working-note.ts";

describe("Theoses2 Working Note", () => {
	it("persists the latest bounded note as a session-log entry", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("x".repeat(WORKING_NOTE_WRITE_CAP + 1));

		expect(manager.getWorkingNote()).toHaveLength(WORKING_NOTE_WRITE_CAP);
		expect(manager.getBranch().at(-1)?.type).toBe("working_note");
	});

	it("appends rather than replaces across multiple calls (issue #173)", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("fact one");
		manager.appendWorkingNote("fact two");

		expect(manager.getWorkingNote()).toBe("fact one\nfact two");
	});

	it("drops the oldest whole lines once the combined note exceeds the cap", () => {
		const manager = SessionManager.inMemory();
		const line = "x".repeat(Math.floor(WORKING_NOTE_WRITE_CAP / 2));
		manager.appendWorkingNote(`first ${line}`);
		manager.appendWorkingNote(`second ${line}`);
		manager.appendWorkingNote(`third ${line}`);

		const note = manager.getWorkingNote();
		expect(note.length).toBeLessThanOrEqual(WORKING_NOTE_WRITE_CAP);
		expect(note).not.toContain("first");
		expect(note).toContain("third");
	});

	it("clears the note once the task tracking it is complete", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("established facts about task A");
		expect(manager.getWorkingNote()).toBe("established facts about task A");

		manager.clearWorkingNote();

		expect(manager.getWorkingNote()).toBe("");
		expect(manager.getBranch().at(-1)?.type).toBe("working_note");
	});

	it("tool calls write on note and clear on clear:true, once the task is complete", async () => {
		const manager = SessionManager.inMemory();
		const tool = createWorkingNoteToolDefinition(
			(note) => manager.appendWorkingNote(note),
			() => manager.clearWorkingNote(),
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

	it("is not stale while empty, or while under the stale-turn threshold", () => {
		const manager = SessionManager.inMemory();
		expect(manager.isWorkingNoteStale()).toBe(false);

		manager.appendWorkingNote("tracking task A");
		for (let i = 0; i < WORKING_NOTE_STALE_TURNS; i++) {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}` }],
				timestamp: Date.now() + i,
			});
		}
		expect(manager.isWorkingNoteStale()).toBe(false);
	});

	it("goes stale once WORKING_NOTE_STALE_TURNS user turns pass without the note being touched", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("tracking task A");
		for (let i = 0; i < WORKING_NOTE_STALE_TURNS + 1; i++) {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}` }],
				timestamp: Date.now() + i,
			});
		}

		expect(manager.isWorkingNoteStale()).toBe(true);
	});

	it("resets staleness once the note is rewritten", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("tracking task A");
		for (let i = 0; i < WORKING_NOTE_STALE_TURNS + 1; i++) {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}` }],
				timestamp: Date.now() + i,
			});
		}
		manager.appendWorkingNote("tracking task B");

		expect(manager.isWorkingNoteStale()).toBe(false);
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
