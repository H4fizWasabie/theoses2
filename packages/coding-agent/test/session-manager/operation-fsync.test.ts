import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const fsync = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync: (fd: number) => {
			fsync.calls++;
			return actual.fsyncSync(fd);
		},
	};
});

// An append reaches the page cache, not the disk. A power loss or kernel panic can still drop the tail of the log,
// including the entry that says the turn finished. So the log is forced to disk once per operation, when it ends:
// about 1-4 ms per turn (measured, issue #426), against turns that run for seconds to minutes. Not per entry.
describe("SessionManager forces the log to disk when an operation ends", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `operation-fsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		fsync.calls = 0;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const userMessage = { role: "user" as const, content: "hi", timestamp: 1 };

	it("syncs once for the operation_finished entry", () => {
		const session = SessionManager.create(tempDir, tempDir, { channel: "telegram", channelSessionId: "1" });
		session.appendMessage(userMessage);
		const before = fsync.calls;

		session.appendOperationFinished("completed");

		expect(fsync.calls - before).toBe(1);
	});

	it("does not sync on ordinary entries", () => {
		const session = SessionManager.create(tempDir, tempDir, { channel: "telegram", channelSessionId: "1" });

		session.appendMessage(userMessage);
		session.appendMessage(userMessage);

		expect(fsync.calls).toBe(0);
	});

	it("does nothing for an in-memory session", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage);

		session.appendOperationFinished("completed");

		expect(fsync.calls).toBe(0);
	});

	it("does not fail the turn when the sync fails", () => {
		const session = SessionManager.create(tempDir, tempDir, { channel: "telegram", channelSessionId: "1" });
		session.appendMessage(userMessage);
		vi.spyOn(session, "syncToDisk").mockImplementation(() => {
			throw new Error("EIO");
		});

		expect(() => session.appendOperationFinished("completed")).not.toThrow();
	});
});
