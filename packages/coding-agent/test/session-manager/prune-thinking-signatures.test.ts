import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager compaction prunes historical thinkingSignature from disk", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prune-thinking-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function assistantWithThinking(thinkingSignature: string) {
		return {
			role: "assistant" as const,
			content: [
				{ type: "thinking" as const, thinking: "reasoning", thinkingSignature },
				{ type: "text" as const, text: "answer" },
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

	it("strips thinkingSignature from entries behind the compaction boundary, on disk", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(assistantWithThinking("x".repeat(1000)));
		session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const keptId = session.appendMessage(assistantWithThinking("y".repeat(1000)));

		session.appendCompaction("summary of first exchange", keptId, 100);

		const entries = session.getEntries();
		const messages = entries.filter((e) => e.type === "message");
		const firstAssistant = messages[1] as any;
		const secondAssistant = messages[3] as any;

		const firstThinking = firstAssistant.message.content.find((b: any) => b.type === "thinking");
		const secondThinking = secondAssistant.message.content.find((b: any) => b.type === "thinking");

		expect(firstThinking.thinkingSignature).toBeUndefined();
		expect(firstThinking.thinking).toBe("reasoning"); // text itself is untouched
		expect(secondThinking.thinkingSignature).toBe("y".repeat(1000)); // not yet behind the boundary

		// Also verify it's actually gone from the persisted file, not just in-memory.
		const fileContent = readFileSync(session.getSessionFile() as string, "utf-8");
		expect(fileContent).not.toContain("x".repeat(1000));
		expect(fileContent).toContain("y".repeat(1000));
	});

	it("does nothing when the compaction boundary is at or before the first entry", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const firstId = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(assistantWithThinking("x".repeat(1000)));

		session.appendCompaction("no-op", firstId, 0);

		const entries = session.getEntries();
		const assistantEntry = entries.find(
			(e) => e.type === "message" && (e as any).message.role === "assistant",
		) as any;
		const thinking = assistantEntry.message.content.find((b: any) => b.type === "thinking");
		expect(thinking.thinkingSignature).toBe("x".repeat(1000));
	});
});
