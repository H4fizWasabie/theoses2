/**
 * A task reset leaves an index of the turns it dropped (#582): request, reply head and tail, and each turn's
 * tool-output ids with the paths they were saved to. It is computed once, into the compaction summary.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { buildResetIndex, RESET_INDEX_MAX_CHARS } from "../src/core/compaction/reset-index.ts";
import { createCompactionRun } from "../src/core/compaction/run.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { MemoryPromotion } from "../src/core/memory-promotion.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TASK_BOUNDARY_CUSTOM_TYPE } from "../src/core/task-boundary-detector.ts";
import { spillPrunedText } from "../src/core/tools/output-shaping.ts";

type Appendable = Parameters<SessionManager["appendMessage"]>[0];
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text: string): Appendable =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as Appendable;
const assistant = (text: string): Appendable =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason: "stop",
		timestamp: 1,
	}) as Appendable;
const result = (text: string, toolCallId: string): Appendable =>
	({
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	}) as Appendable;

function withManager(run: (manager: SessionManager) => Promise<void> | void) {
	const root = join(tmpdir(), `theoses-reset-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "sessions"), { recursive: true });
	return Promise.resolve(run(SessionManager.create(root, join(root, "sessions")))).finally(() =>
		rmSync(root, { recursive: true, force: true }),
	);
}

describe("buildResetIndex (#582)", () => {
	it("lists one entry per dropped turn with request, reply head and tail, and ids with existing paths", () =>
		withManager((manager) => {
			const reply = `HEADTEXT${"m".repeat(2000)}TAILTEXT`;
			const messages = [
				user("fix the auth bug\nsecond line"),
				result("⟨t3⟩\nBASH ONE", "c3"),
				result("⟨t4⟩\nBASH TWO", "c4"),
				assistant(reply),
				user("now add tests"),
				assistant("added"),
			] as never[];

			const index = buildResetIndex(messages, "weather", (name, text) => spillPrunedText(manager, name, text));

			expect(index).toContain("fix the auth bug");
			expect(index).not.toContain("second line");
			expect(index).toContain("HEADTEXT");
			expect(index).toContain("TAILTEXT");
			expect(index).toContain("now add tests");
			expect(index.length).toBeLessThan(2000);
			const dir = manager.getArtifactDirectory();
			for (const [id, text] of [
				["t3", "BASH ONE"],
				["t4", "BASH TWO"],
			]) {
				const path = join(dir, `pruned-result-${id}.txt`);
				expect(index).toContain(`⟨${id}⟩ ${path}`);
				expect(existsSync(path)).toBe(true);
				expect(readFileSync(path, "utf8")).toBe(text);
			}
		}));

	it("drops the oldest turns first when over the cap and says so", () =>
		withManager((manager) => {
			const messages = [];
			for (let i = 0; i < 200; i++)
				messages.push(user(`request number ${i} ${"x".repeat(150)}`), assistant(`reply ${i}`));

			const index = buildResetIndex(messages as never[], "t", (name, text) => spillPrunedText(manager, name, text));

			expect(index.length).toBeLessThanOrEqual(RESET_INDEX_MAX_CHARS + 400);
			expect(index).toContain("request number 199");
			expect(index).not.toContain("request number 0 ");
			expect(index).toContain(`capped at ${RESET_INDEX_MAX_CHARS}`);
		}));

	it("is identical for identical input", () =>
		withManager((manager) => {
			const messages = [user("a"), result("⟨t1⟩\nX", "c1"), assistant("b")] as never[];
			const spill = (name: string, text: string) => spillPrunedText(manager, name, text);
			expect(buildResetIndex(messages, "t", spill)).toBe(buildResetIndex(messages, "t", spill));
		}));
});

describe("a task reset run stores the index in the compaction entry (#582)", () => {
	it("prepends the index to the summary, once", () =>
		withManager(async (manager) => {
			manager.appendMessage(user("old task request"));
			manager.appendMessage(result("⟨t1⟩\nOLD OUTPUT", "c1"));
			manager.appendMessage(assistant("old task reply"));
			manager.appendMessage(user("new task request"));
			const newTaskId = manager.getLeafId() as string;
			manager.appendMessage(assistant("new task reply"));
			manager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, { taskSummary: "new task", beforeEntryId: newTaskId });
			manager.appendMessage(user("more"));
			manager.appendMessage(assistant("more reply"));

			const run = createCompactionRun({
				sessionManager: manager,
				getExtensionRunner: () =>
					({ hasHandlers: () => false, emit: async () => undefined }) as unknown as ExtensionRunner,
				memoryPromotion: { promoteDropped: () => {}, settle: async () => {} } as unknown as MemoryPromotion,
				getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 }),
				setMessages: () => {},
				emit: () => {},
				prepareSummarizer: async () => async (preparation) => ({
					summary: "SUMMARY",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 0,
				}),
			});
			const outcome = await run.run({ reason: "manual" });

			expect(outcome.kind).toBe("completed");
			const entry = manager.getEntries().find((e) => e.type === "compaction");
			const summary = entry?.type === "compaction" ? entry.summary : "";
			expect(summary).toContain("old task request");
			expect(summary).toContain("⟨t1⟩");
			expect(summary).toContain("SUMMARY");
			expect(summary).not.toContain("new task request");
			const path = join(manager.getArtifactDirectory(), "pruned-result-t1.txt");
			expect(readFileSync(path, "utf8")).toBe("OLD OUTPUT");
		}));
});
