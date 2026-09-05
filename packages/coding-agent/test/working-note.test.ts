import { describe, expect, it } from "vitest";
import {
	limitActiveContextMessages,
	SessionManager,
	WORKING_NOTE_INJECTION_CAP,
	WORKING_NOTE_WRITE_CAP,
} from "../src/core/session-manager.ts";

describe("Theoses2 Working Note", () => {
	it("persists the latest bounded note as a session-log entry", () => {
		const manager = SessionManager.inMemory();
		manager.appendWorkingNote("x".repeat(WORKING_NOTE_WRITE_CAP + 1));

		expect(manager.getWorkingNote()).toHaveLength(WORKING_NOTE_WRITE_CAP);
		expect(manager.getBranch().at(-1)?.type).toBe("working_note");
	});

	it("keeps the last five user turns and their responses", () => {
		const messages = Array.from({ length: 6 }, (_, index) => [
			{ role: "user", content: `user-${index}` },
			{ role: "assistant", content: [{ type: "text", text: `assistant-${index}` }] },
		]).flat();

		const active = limitActiveContextMessages(messages as never[]);
		expect(active).toHaveLength(10);
		expect(active[0]).toMatchObject({ content: "user-1" });
	});

	it("uses the resolved channel key and keeps the documented caps", () => {
		const manager = SessionManager.inMemory();
		manager.newSession({ channel: "telegram", channelSessionId: "chat-1" });

		expect(manager.getChannelSessionKey()).toEqual({ channel: "telegram", channelSessionId: "chat-1" });
		expect(WORKING_NOTE_WRITE_CAP).toBe(2000);
		expect(WORKING_NOTE_INJECTION_CAP).toBe(2000);
	});
});
