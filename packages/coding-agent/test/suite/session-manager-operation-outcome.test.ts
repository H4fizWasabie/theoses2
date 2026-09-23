import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "theoses-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

describe("SessionManager.getLastOperationOutcome", () => {
	const dirs: string[] = [];
	function tempCwd(): string {
		const dir = mkdtempSync(join(tmpdir(), "theoses-operation-outcome-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("returns undefined for a fresh in-memory session", () => {
		const manager = SessionManager.inMemory();
		expect(manager.getLastOperationOutcome()).toBeUndefined();
	});

	it("returns the recorded outcome for a normally finished turn, live in the same process", () => {
		const cwd = tempCwd();
		const path = join(cwd, "session.jsonl");
		const manager = SessionManager.open(path);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		manager.appendOperationFinished("aborted");
		expect(manager.getLastOperationOutcome()).toBe("aborted");
	});

	it("does not flag a live process's own dangling turn (e.g. test fixtures seeding raw entries) as interrupted", () => {
		// Same in-process instance: appendMessage without a following appendOperationFinished just
		// means the turn hasn't finished yet in this process, not that a prior process crashed.
		const cwd = tempCwd();
		const path = join(cwd, "session.jsonl");
		const manager = SessionManager.open(path);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "still running" }],
			timestamp: Date.now(),
		});
		expect(manager.getLastOperationOutcome()).toBeUndefined();
	});

	it("reports 'interrupted' when a session is reopened (simulating a restart) with a dangling turn on disk", () => {
		const cwd = tempCwd();
		const path = join(cwd, "session.jsonl");
		const writer = SessionManager.open(path);
		writer.appendMessage({ role: "user", content: [{ type: "text", text: "start a task" }], timestamp: Date.now() });
		writer.appendMessage(assistantMessage("working on it"));
		// No appendOperationFinished: simulates the process dying mid-turn before it could write one.

		const reopened = SessionManager.open(path);
		expect(reopened.getLastOperationOutcome()).toBe("interrupted");
	});

	it("clears the 'interrupted' flag once the reopened process appends its own operation_finished", () => {
		const cwd = tempCwd();
		const path = join(cwd, "session.jsonl");
		const writer = SessionManager.open(path);
		writer.appendMessage({ role: "user", content: [{ type: "text", text: "start a task" }], timestamp: Date.now() });
		writer.appendMessage(assistantMessage("working on it"));

		const reopened = SessionManager.open(path);
		expect(reopened.getLastOperationOutcome()).toBe("interrupted");
		reopened.appendOperationFinished("completed");
		expect(reopened.getLastOperationOutcome()).toBe("completed");
	});

	it("does not flag a cleanly closed session as interrupted on reopen", () => {
		const cwd = tempCwd();
		const path = join(cwd, "session.jsonl");
		const writer = SessionManager.open(path);
		writer.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		writer.appendMessage(assistantMessage("done"));
		writer.appendOperationFinished("completed");

		const reopened = SessionManager.open(path);
		expect(reopened.getLastOperationOutcome()).toBe("completed");
	});
});
