/**
 * Tool output that leaves the live context unmarked (#581): the context-window drop, compaction and a task reset
 * all save its full text under the same name turn-start pruning uses, so its ⟨tN⟩ id stays recoverable.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../src/core/compaction/compaction.ts";
import { createCompactionRun } from "../src/core/compaction/run.ts";
import { pruneFinishedTurnOutputs, spillEvictedToolResults } from "../src/core/context-pruning.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { MemoryPromotion } from "../src/core/memory-promotion.ts";
import {
	type CompactionEntry,
	type CustomEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";
import { TASK_BOUNDARY_CUSTOM_TYPE, type TaskBoundaryData } from "../src/core/task-boundary-detector.ts";
import { spillPrunedText } from "../src/core/tools/output-shaping.ts";

const CAPS = { toolResultMaxChars: 1500, toolCallArgsMaxChars: 1500 };
/** What a session log accepts. The helpers below build these so they can be appended and also passed as AgentMessage. */
type Appendable = Parameters<SessionManager["appendMessage"]>[0];
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResult(text: string, toolCallId = "call_1"): Appendable {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as Appendable;
}

function userText(text: string): Appendable {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as Appendable;
}

function assistantText(text: string): Appendable {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason: "stop",
		timestamp: 1,
	} as Appendable;
}

describe("spillEvictedToolResults", () => {
	let root: string;
	let manager: SessionManager;

	beforeEach(() => {
		root = join(tmpdir(), `theoses-evicted-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "sessions"), { recursive: true });
		manager = SessionManager.create(root, join(root, "sessions"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const spill = (name: string, text: string) => spillPrunedText(manager, name, text);

	it("saves the full text of an unpruned result under its tool-output id, without the id prefix", () => {
		spillEvictedToolResults([toolResult("⟨t4⟩\nsmall output")], spill);

		const dir = manager.getArtifactDirectory();
		expect(readdirSync(dir)).toEqual(["pruned-result-t4.txt"]);
		expect(readFileSync(join(dir, "pruned-result-t4.txt"), "utf8")).toBe("small output");
	});

	it("falls back to the tool call id for a result from before ids existed", () => {
		spillEvictedToolResults([toolResult("old output", "call_9")], spill);

		expect(readdirSync(manager.getArtifactDirectory())).toEqual(["pruned-result-call_9.txt"]);
	});

	it("writes the same file turn-start pruning writes, and nothing new for a result already cut", () => {
		const input = [toolResult(`⟨t3⟩\n${"q".repeat(5000)}`)];
		const cut = pruneFinishedTurnOutputs(input, { ...CAPS, spill }).messages;
		const filesAfterPruning = readdirSync(manager.getArtifactDirectory());

		spillEvictedToolResults(cut, spill);
		spillEvictedToolResults(input, spill);

		expect(filesAfterPruning).toEqual(["pruned-result-t3.txt"]);
		expect(readdirSync(manager.getArtifactDirectory())).toEqual(filesAfterPruning);
		expect(readFileSync(join(manager.getArtifactDirectory(), "pruned-result-t3.txt"), "utf8")).toBe("q".repeat(5000));
	});

	it("does nothing without a way to save", () => {
		expect(() => spillEvictedToolResults([toolResult("⟨t4⟩\nx")], undefined)).not.toThrow();
		expect(readdirSync(manager.getArtifactDirectory())).toEqual([]);
	});
});

describe("rotation keeps tool-output ids (#581 criteria)", () => {
	it("carries the highest id into the new log when its kept tail has no tool result", () => {
		const root = join(tmpdir(), `theoses-evicted-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "sessions"), { recursive: true });
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendMessage(userText("first"));
			manager.appendMessage(toolResult("⟨t5⟩\nOLD OUTPUT", "call_5"));
			manager.appendMessage(assistantText("done"));
			manager.appendMessage(userText("tail with no tool result"));
			manager.appendMessage(assistantText("tail answer"));

			manager.rotate();

			expect(manager.getHeader()?.carriedToolOutputId).toBe(5);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function messageEntry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message } as SessionMessageEntry;
}

describe("compaction and task reset keep evicted tool output (#581)", () => {
	const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 };

	it("a task reset reports the abandoned task's messages so compaction can save their tool output", () => {
		const u1 = messageEntry("u1", userText("fix the auth bug".repeat(8)));
		const a1 = messageEntry("a1", assistantText("fixed it".repeat(8)));
		const u2 = messageEntry("u2", userText("continuing the bug fix".repeat(8)));
		const abandoned = messageEntry("t2", toolResult("⟨t2⟩\nABANDONED OUTPUT", "call_abandoned"));
		const a2 = messageEntry("a2", assistantText("added tests".repeat(8)));
		const c0 = {
			type: "compaction",
			id: "c0",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "Old summary",
			firstKeptEntryId: "u2",
			tokensBefore: 10000,
		} as CompactionEntry;
		const u3 = messageEntry("u3", userText("what's the weather like".repeat(8)));
		const a3 = messageEntry("a3", assistantText("no tools for that".repeat(8)));
		const boundary = {
			type: "custom",
			id: "boundary",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: TASK_BOUNDARY_CUSTOM_TYPE,
			data: { taskSummary: "asking about the weather", beforeEntryId: "u3" } satisfies TaskBoundaryData,
		} as CustomEntry<TaskBoundaryData>;
		const u4 = messageEntry("u4", userText("anything else".repeat(8)));
		const a4 = messageEntry("a4", assistantText("nope".repeat(8)));
		const pathEntries: SessionEntry[] = [u1, a1, u2, abandoned, a2, c0, u3, a3, boundary, u4, a4];

		const preparation = prepareCompaction(pathEntries, settings);

		expect(preparation?.chainReset).toBeDefined();
		const dropped = preparation?.chainReset?.droppedMessages ?? [];
		expect(dropped.some((message) => message.role === "toolResult" && message.toolCallId === "call_abandoned")).toBe(
			true,
		);
	});

	it("a compaction run saves the tool output of the messages it summarizes, after committing the compaction", async () => {
		const root = join(tmpdir(), `theoses-evicted-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "sessions"), { recursive: true });
		try {
			const sessionManager = SessionManager.create(root, join(root, "sessions"));
			sessionManager.appendMessage(userText("first question".repeat(8)));
			sessionManager.appendMessage(toolResult("⟨t1⟩\nSUMMARIZED OUTPUT", "call_1"));
			sessionManager.appendMessage(assistantText("first answer".repeat(8)));
			sessionManager.appendMessage(userText("second question".repeat(8)));
			sessionManager.appendMessage(assistantText("second answer".repeat(8)));

			const run = createCompactionRun({
				sessionManager,
				getExtensionRunner: () =>
					({ hasHandlers: () => false, emit: async () => undefined }) as unknown as ExtensionRunner,
				memoryPromotion: { promoteDropped: () => {}, settle: async () => {} } as unknown as MemoryPromotion,
				getCompactionSettings: () => settings,
				setMessages: () => {},
				emit: () => {},
				prepareSummarizer: async () => async (preparation) => ({
					summary: "summary",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 0,
				}),
			});
			const outcome = await run.run({ reason: "manual" });

			expect(outcome.kind).toBe("completed");
			const dir = sessionManager.getArtifactDirectory();
			expect(readFileSync(join(dir, "pruned-result-t1.txt"), "utf8")).toBe("SUMMARIZED OUTPUT");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
