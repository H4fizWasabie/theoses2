import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "theoses-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	FILE_CHECKPOINT_ENTRY_TYPE,
	type FileCheckpoint,
	originalsSince,
	planFileRewind,
	rewindPoints,
} from "../src/core/file-checkpoints.ts";
import { selectConsolidationWindow } from "../src/core/memory-promotion.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SESSION_ROTATE_BYTES, SESSION_ROTATED_ENTRY_TYPE, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TASK_BOUNDARY_CUSTOM_TYPE, TASK_DESCRIPTOR_CUSTOM_TYPE } from "../src/core/task-boundary-detector.ts";
import { currentTaskPlan, TASK_PLAN_ENTRY_TYPE, type TaskPlan } from "../src/core/task-plan.ts";
import { createRecallTurnsToolDefinition } from "../src/core/tools/recall-turns.ts";

const usage = {
	input: 100,
	output: 20,
	cacheRead: 300,
	cacheWrite: 4,
	totalTokens: 424,
	cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.0037 },
};
const user = (text: string, extra: unknown[] = []) =>
	({ role: "user", content: [{ type: "text", text }, ...extra], timestamp: Date.now() }) as never;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;
const plan = (goal: string): TaskPlan => ({
	kind: "change",
	goal,
	request: goal,
	items: [],
	createdAt: new Date().toISOString(),
});
const photo = Buffer.alloc(6000, 9).toString("base64");
const key = { channel: "telegram", channelSessionId: "42" };

/** What a session answers through its getters; rotation must not change any of it. */
function state(manager: SessionManager) {
	const context = manager.buildSessionContext();
	return {
		messages: JSON.stringify(context.messages),
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		workingNote: manager.getWorkingNote(),
		taskPlan: currentTaskPlan(manager.getBranch())?.data,
		sessionName: manager.getSessionName(),
		lastOutcome: manager.getLastOperationOutcome(),
		artifacts: manager.getArtifactCatalog(),
		unpromoted: selectConsolidationWindow(manager.getBranch()).map((entry) => entry.id),
	};
}

const checkpointTurns = (manager: SessionManager) =>
	manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === FILE_CHECKPOINT_ENTRY_TYPE
				? [(entry.data as FileCheckpoint).turnId]
				: [],
		);

describe("session log rotation", () => {
	let root: string;
	let sessionDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `theoses-session-rotation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	/** An earlier task (promoted, checkpointed), a task boundary, the current task with its plan, then a compaction keeping its last turn. */
	function longSession() {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
		const manager = SessionManager.create(root, sessionDir, key);
		manager.appendModelChange("openrouter", "z-ai/glm-5.3-flash");
		manager.appendThinkingLevelChange("high");
		manager.appendSessionInfo("main");
		const first = manager.appendMessage(user("first question"));
		manager.appendCustomEntry(FILE_CHECKPOINT_ENTRY_TYPE, { turnId: first, path: "/tmp/a", hash: null });
		manager.appendMessage(assistant("first answer"));
		manager.writeWorkingNote("old note");
		manager.storeArtifact("report", "report.txt", new TextEncoder().encode("report"));
		const anchor = manager.appendMessage(user("second task"));
		manager.appendCustomEntry(FILE_CHECKPOINT_ENTRY_TYPE, { turnId: anchor, path: "/tmp/b", hash: null });
		manager.appendCustomEntry(TASK_PLAN_ENTRY_TYPE, plan("second task"));
		const answer = manager.appendMessage(assistant("second answer"));
		manager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, { taskSummary: "second task", beforeEntryId: anchor });
		manager.appendCustomEntry(TASK_DESCRIPTOR_CUSTOM_TYPE, { descriptor: "second task" });
		manager.appendPromotedRange(first, answer);
		manager.writeWorkingNote("current note");
		vi.setSystemTime(Date.now() + 1000); // the next turn starts after the plan was created
		const kept = manager.appendMessage(user("look at this", [{ type: "image", data: photo, mimeType: "image/png" }]));
		manager.appendCustomEntry(FILE_CHECKPOINT_ENTRY_TYPE, { turnId: kept, path: "/tmp/c", hash: null });
		const keptAnswer = manager.appendMessage(assistant("a photo"));
		manager.appendLabelChange(keptAnswer, "bookmark");
		manager.appendCompaction("summary of both tasks", kept, 1000);
		manager.appendOperationFinished("completed");
		return { manager, first, anchor, kept, keptAnswer };
	}

	it("continues in a new log that answers every getter as before and drops what nothing reads", () => {
		const { manager, first, anchor, kept, keptAnswer } = longSession();
		const oldFile = manager.getSessionFile() as string;
		const oldId = manager.getSessionId();
		const before = state(manager);

		const newFile = manager.rotate() as string;

		expect(newFile).not.toBe(oldFile);
		expect(manager.getSessionFile()).toBe(newFile);
		expect(manager.getSessionId()).not.toBe(oldId);
		expect(manager.getHeader()).toMatchObject({ parentSession: oldFile, ...key });
		expect(state(manager)).toEqual(before);
		expect(manager.getLabel(keptAnswer)).toBe("bookmark");
		expect(checkpointTurns(manager)).toEqual([anchor, kept]);

		const raw = readFileSync(newFile, "utf8");
		expect(raw).not.toContain("first question");
		expect(raw).not.toContain(photo);
		expect(manager.getEntry(first)).toBeUndefined();

		const lastOld = JSON.parse(readFileSync(oldFile, "utf8").trim().split("\n").at(-1) as string);
		expect(lastOld).toMatchObject({ type: "custom", customType: SESSION_ROTATED_ENTRY_TYPE, data: { to: newFile } });

		const reopened = SessionManager.open(newFile);
		expect(state(reopened)).toEqual(before);
		expect(reopened.buildSessionContext().messages.length).toBeGreaterThan(0);
		expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain(photo);
	});

	it("keeps appending to the new log and is found by channel lookup, even before the next message", async () => {
		const { manager } = longSession();
		const newFile = manager.rotate() as string;

		const [found] = await SessionManager.list(root, sessionDir, undefined, key);
		expect(found?.path).toBe(newFile);

		manager.appendMessage(user("after rotation"));
		manager.appendMessage(assistant("still here"));
		expect(readFileSync(newFile, "utf8")).toContain("after rotation");
		expect(JSON.stringify(SessionManager.open(newFile).buildSessionContext().messages)).toContain("still here");
	});

	it("carries messages Durable Memory has not consolidated yet, outside the model's context", () => {
		const manager = SessionManager.create(root, sessionDir, key);
		manager.appendMessage(user("pending fact"));
		manager.appendMessage(assistant("noted"));
		const kept = manager.appendMessage(user("latest"));
		manager.appendMessage(assistant("latest answer"));
		manager.appendCompaction("summary", kept, 100);
		const before = state(manager);
		expect(before.unpromoted).toHaveLength(4);

		manager.rotate();

		expect(state(manager)).toEqual(before);
		expect(before.messages).not.toContain("pending fact");
	});

	it("does not bring back a plan from an earlier task", () => {
		const manager = SessionManager.create(root, sessionDir, key);
		manager.appendCustomEntry(TASK_PLAN_ENTRY_TYPE, plan("earlier task"));
		manager.appendMessage(user("earlier"));
		manager.appendMessage(assistant("done"));
		const anchor = manager.appendMessage(user("new task"));
		manager.appendMessage(assistant("on it"));
		manager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, { taskSummary: "new task", beforeEntryId: anchor });
		manager.appendCompaction("summary", anchor, 100);
		expect(currentTaskPlan(manager.getBranch())?.data).toBeUndefined();

		manager.rotate();

		expect(currentTaskPlan(manager.getBranch())?.data).toBeUndefined();
		expect(readFileSync(manager.getSessionFile() as string, "utf8")).not.toContain("earlier task");
	});

	it("rotates on its own at a compaction once the log reaches the size limit", () => {
		const manager = SessionManager.create(root, sessionDir, key);
		const start = manager.appendMessage(user("start"));
		manager.appendPromotedRange(start, manager.appendMessage(assistant("x".repeat(SESSION_ROTATE_BYTES))));
		const oldFile = manager.getSessionFile() as string;
		const kept = manager.appendMessage(user("latest"));
		manager.appendMessage(assistant("latest answer"));

		const compactionId = manager.appendCompaction("summary", kept, 100);

		const newFile = manager.getSessionFile() as string;
		expect(newFile).not.toBe(oldFile);
		expect(existsSync(oldFile)).toBe(true);
		expect(statSync(newFile).size).toBeLessThan(10_000);
		expect(manager.getEntry(compactionId)?.type).toBe("compaction");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"leaves the old log untouched and in use when the new log cannot be written",
		() => {
			const { manager } = longSession();
			const oldFile = manager.getSessionFile() as string;
			const before = readFileSync(oldFile, "utf8");
			chmodSync(sessionDir, 0o555); // the old log stays writable; a new file in the directory cannot be created
			try {
				expect(() => manager.rotate()).toThrow();
			} finally {
				chmodSync(sessionDir, 0o755);
			}

			expect(readFileSync(oldFile, "utf8")).toBe(before);
			expect(manager.getSessionFile()).toBe(oldFile);
			manager.appendMessage(user("still the old log"));
			expect(readFileSync(oldFile, "utf8")).toContain("still the old log");
		},
	);

	it("releases the provider resources under the id the agent was created with", async () => {
		const released: Array<string | undefined> = [];
		const unregister = registerSessionResourceCleanup((id) => released.push(id));
		try {
			const { manager } = longSession();
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: join(root, "agent"),
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory(),
			});
			const opened = manager.getSessionId();
			manager.rotate();

			session.dispose();

			expect(released).toEqual([opened]);
		} finally {
			unregister();
		}
	});

	/**
	 * Every turn changes files. Two consolidated turns that rotation drops, with an abandoned branch after them; the
	 * turn a Task Plan was created in (consolidated, so only the plan keeps it); an old turn Durable Memory has not
	 * consolidated; a consolidated turn after it; and the turn the last compaction kept. An extension saves state
	 * along the way. The clock moves a second per turn, as it does between real turns.
	 */
	function historySession() {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
		const manager = SessionManager.create(root, sessionDir, key);
		const turn = (text: string, files: Record<string, string | null>, during?: () => void) => {
			vi.setSystemTime(Date.now() + 1000);
			const id = manager.appendMessage(user(text));
			during?.();
			for (const [path, hash] of Object.entries(files)) {
				manager.appendCustomEntry(FILE_CHECKPOINT_ENTRY_TYPE, { turnId: id, path, hash });
			}
			return { id, answer: manager.appendMessage(assistant(`answer to ${text}`)) };
		};
		manager.appendModelChange("openrouter", "z-ai/glm-5.3-flash");
		const t1 = turn("the deploy key is in vault-7", { "/x": "x1" });
		manager.appendCustomEntry("ext-state", { version: 1 });
		const t2 = turn("second consolidated turn", { "/y": "y1" });
		manager.appendCustomEntry("ext-other", { kept: true });
		const promoted = manager.appendPromotedRange(t1.id, t2.answer);
		turn("an abandoned idea", { "/q": null });
		manager.branch(promoted);
		const planTurn = turn("start the plan task", { "/x": "x2", "/z": null }, () =>
			manager.appendCustomEntry(TASK_PLAN_ENTRY_TYPE, plan("plan")),
		);
		manager.appendPromotedRange(planTurn.id, planTurn.answer);
		const pending = turn("pending fact about the boiler", { "/w": "w1" });
		manager.appendCustomEntry("ext-state", { version: 2 });
		const later = turn("consolidated later", { "/y": "y2" });
		manager.appendPromotedRange(later.id, later.answer);
		manager.appendCustomEntry("ext-state", { version: 3 });
		const latest = turn("latest turn", { "/z": "z2", "/x": "x3" });
		manager.appendCompaction("summary", latest.id, 1000, undefined, undefined, usage);
		manager.appendOperationFinished("completed");
		return { manager, t1, t2, planTurn, pending, later, latest };
	}

	it("offers the same rewinds inside the kept tail, restoring the same files, and none before it", () => {
		const { manager, planTurn, pending, later, latest } = historySession();
		const before = new Map(
			rewindPoints(manager.getBranch()).map((p) => [p.entryId, planFileRewind(manager.getBranch(), p.entryId)]),
		);

		manager.rotate();

		const points = rewindPoints(manager.getBranch()).map((p) => p.entryId);
		expect(points).toEqual([latest.id, later.id, pending.id, planTurn.id]);
		for (const id of points) expect(planFileRewind(manager.getBranch(), id)).toEqual(before.get(id));
	});

	it("gives Plan Review the same files for the active Task Plan", () => {
		const { manager } = historySession();
		const directory = manager.getCheckpointDirectory();
		const createdAt = currentTaskPlan(manager.getBranch())?.data?.createdAt as string;
		const before = originalsSince(manager.getBranch(), directory, createdAt);
		expect(before.files.length + before.skipped.length).toBe(4);

		manager.rotate();

		expect(originalsSince(manager.getBranch(), directory, createdAt)).toEqual(before);
		expect(
			originalsSince(SessionManager.open(manager.getSessionFile() as string).getBranch(), directory, createdAt),
		).toEqual(before);
	});

	it("lets recall_turns find a dropped turn in the log before, but not from a fork of the session", async () => {
		const { manager } = historySession();
		const recall = async (session: SessionManager, query: string) => {
			const result = await createRecallTurnsToolDefinition().execute("call", { query }, undefined, undefined, {
				sessionManager: session,
			} as unknown as ExtensionContext);
			const first = result.content[0];
			return first?.type === "text" ? first.text : "";
		};
		expect(await recall(manager, "deploy key vault-7")).toContain("vault-7");

		manager.rotate();
		manager.rotate(); // two logs back

		expect(await recall(manager, "deploy key vault-7")).toContain("vault-7");
		const boiler = await recall(manager, "boiler");
		expect(boiler.split("\n")).toHaveLength(2); // a kept turn and its answer, once each though every log holds them
		const fork = SessionManager.forkFrom(manager.getSessionFile() as string, root, sessionDir);
		expect(await recall(fork, "deploy key vault-7")).toBe("No matching turns found in this session.");
	});

	it("keeps whole-session totals: usage, cost, message counts and compactions", () => {
		const { manager } = historySession();
		const totals = (session: SessionManager) => session.getSessionTotals();
		const before = totals(manager);
		// Seven turns, the abandoned one included; seven answers and the compaction paid.
		expect(before).toMatchObject({ userMessages: 7, assistantMessages: 7, totalMessages: 14, compactions: 1 });
		expect(before.usage.cost).toBeCloseTo(8 * 0.0037);

		manager.rotate();
		manager.appendCompaction("summary again", manager.getBranch().at(-1)?.id as string, 1000);
		manager.rotate();

		const after = { ...before, compactions: 2 };
		expect(totals(manager)).toEqual(after);
		expect(totals(SessionManager.open(manager.getSessionFile() as string))).toEqual(after);
	});

	it("keeps the latest state an extension saved of each type, and its entries in the tail in order, across a reopen", () => {
		const { manager } = historySession();
		const saved = (session: SessionManager) =>
			session.getEntries().flatMap((e) => (e.type === "custom" && e.customType.startsWith("ext-") ? [e.data] : []));
		expect(saved(manager)).toEqual([{ version: 1 }, { kept: true }, { version: 2 }, { version: 3 }]);

		manager.rotate();

		expect(saved(SessionManager.open(manager.getSessionFile() as string))).toEqual([
			{ kept: true },
			{ version: 2 },
			{ version: 3 },
		]);
	});

	it("keeps each label as it reads now, a cleared one included, and none for a dropped entry", () => {
		const { manager, t1, later, latest } = historySession();
		manager.appendLabelChange(later.answer, "cleared elsewhere");
		manager.appendLabelChange(latest.id, "kept");
		manager.appendLabelChange(t1.id, "dropped");
		const leaf = manager.getLeafId() as string;
		manager.branch(t1.id); // the clear is on another branch; the label it clears is in the tail
		manager.appendLabelChange(later.answer, undefined);
		manager.branch(leaf);
		const labels = (session: SessionManager) => [later.answer, latest.id].map((id) => session.getLabel(id));
		expect(labels(manager)).toEqual([undefined, "kept"]);

		manager.rotate();

		const reopened = SessionManager.open(manager.getSessionFile() as string);
		for (const session of [manager, reopened]) {
			expect(labels(session)).toEqual([undefined, "kept"]);
			const labelEntries = session.getEntries().filter((entry) => entry.type === "label");
			expect(labelEntries.map((entry) => entry.targetId)).toEqual([latest.id]);
		}
	});

	it("does nothing for a session that is not persisted", () => {
		const manager = SessionManager.inMemory(root);
		manager.appendMessage(user("hi"));
		manager.appendMessage(assistant("hello"));

		expect(manager.rotate()).toBeUndefined();
	});
});
