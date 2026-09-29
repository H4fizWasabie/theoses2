import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager survives a crash mid-write", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `crash-safety-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function assistant(text: string, thinkingSignature?: string) {
		return {
			role: "assistant" as const,
			content: [
				...(thinkingSignature ? [{ type: "thinking" as const, thinking: "reasoning", thinkingSignature }] : []),
				{ type: "text" as const, text },
			],
			api: "openai-completions" as const,
			provider: "openrouter",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function userTexts(file: string): string[] {
		return loadEntriesFromFile(file).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
	}

	it("keeps the first entry written after resuming a log whose last line was torn", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "before crash", timestamp: 1 });
		session.appendMessage(assistant("reply"));
		const file = session.getSessionFile() as string;

		// A crash mid-append leaves half a JSON line with no newline.
		appendFileSync(file, '{"type":"message","id":"torn","parentId":"x","message":{"role":"us');

		const resumed = SessionManager.open(file, tempDir);
		resumed.appendMessage({ role: "user", content: "after resume", timestamp: 2 });

		expect(userTexts(file)).toEqual(["before crash", "after resume"]);
	});

	it("leaves the whole log intact when rewriting it fails partway", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(assistant("a1", "x".repeat(500)));
		session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const keptId = session.appendMessage(assistant("a2", "y".repeat(500)));
		const file = session.getSessionFile() as string;
		const before = readFileSync(file, "utf8");

		// An entry that cannot be serialized stands in for a full disk or a kill during the rewrite:
		// compaction's thinking-signature prune rewrites the whole log and fails on this entry.
		(session as unknown as { fileEntries: unknown[] }).fileEntries.push({
			type: "custom",
			id: "poison",
			toJSON() {
				throw new Error("disk full");
			},
		});

		expect(() => session.appendCompaction("summary", keptId, 100)).toThrow("disk full");

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(userTexts(file)).toEqual(["first", "second"]);
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	describe("the first turn of a session", () => {
		it("is on disk before the first reply for a channel session, so a restart mid-turn reads as interrupted", () => {
			const session = SessionManager.create(tempDir, tempDir, { channel: "telegram", channelSessionId: "chat-1" });
			session.appendMessage({ role: "user", content: "long first task", timestamp: 1 });
			const file = session.getSessionFile() as string;

			// The process dies here, before any assistant message ends.
			expect(userTexts(file)).toEqual(["long first task"]);
			expect(SessionManager.open(file, tempDir).getLastOperationOutcome()).toBe("interrupted");
		});

		it("still waits for the first reply for a CLI session, so an abandoned prompt leaves no file", () => {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage({ role: "user", content: "never answered", timestamp: 1 });
			expect(readdirSync(tempDir).filter((name) => name.endsWith(".jsonl"))).toEqual([]);

			session.appendMessage(assistant("answer"));
			expect(userTexts(session.getSessionFile() as string)).toEqual(["never answered"]);
		});
	});
});
