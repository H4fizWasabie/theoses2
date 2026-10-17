/**
 * Saving pruned output (#581, ADR-0013): a saved file is named by the tool-output id, is never overwritten by a different
 * output that reuses its name, and is the same file however many times the same messages are pruned.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneFinishedTurnOutputs } from "../src/core/context-pruning.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { spillPrunedText } from "../src/core/tools/output-shaping.ts";

const CAPS = { toolResultMaxChars: 1500, toolCallArgsMaxChars: 1500 };

describe("spillPrunedText", () => {
	let root: string;
	let sessionDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `theoses-output-shaping-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("never overwrites a file that holds a different output, even when the name is reused", () => {
		const manager = SessionManager.create(root, sessionDir);

		const first = spillPrunedText(manager, "result-t3.txt", "first output");
		const second = spillPrunedText(manager, "result-t3.txt", "second output");

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(readFileSync(first as string, "utf8")).toBe("first output");
		expect(readFileSync(second as string, "utf8")).toBe("second output");
	});

	it("names the file after the id and gives the same path again for the same text", () => {
		const manager = SessionManager.create(root, sessionDir);

		const path = spillPrunedText(manager, "result-t3.txt", "same text");

		expect(path).toBe(join(manager.getArtifactDirectory(), "pruned-result-t3.txt"));
		expect(spillPrunedText(manager, "result-t3.txt", "same text")).toBe(path);
		expect(readdirSync(manager.getArtifactDirectory())).toEqual(["pruned-result-t3.txt"]);
	});

	it("gives byte-identical markers and the same files when the same messages are pruned again", () => {
		const manager = SessionManager.create(root, sessionDir);
		const spill = (name: string, text: string) => spillPrunedText(manager, name, text);
		const input: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "call_3",
				toolName: "bash",
				content: [{ type: "text", text: `⟨t3⟩\n${"q".repeat(5000)}` }],
				isError: false,
				timestamp: 1,
			} as AgentMessage,
		];

		const first = pruneFinishedTurnOutputs(input, { ...CAPS, spill });
		const filesAfterFirst = readdirSync(manager.getArtifactDirectory());
		const again = pruneFinishedTurnOutputs(input, { ...CAPS, spill });

		expect(again.messages).toEqual(first.messages);
		expect(readdirSync(manager.getArtifactDirectory())).toEqual(filesAfterFirst);
		expect(filesAfterFirst).toEqual(["pruned-result-t3.txt"]);
	});
});
