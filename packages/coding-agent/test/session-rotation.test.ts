import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "theoses-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_CHECKPOINT_ENTRY_TYPE, type FileCheckpoint } from "../src/core/file-checkpoints.ts";
import { selectConsolidationWindow } from "../src/core/memory-promotion.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SESSION_ROTATE_BYTES, SESSION_ROTATED_ENTRY_TYPE, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TASK_BOUNDARY_CUSTOM_TYPE, TASK_DESCRIPTOR_CUSTOM_TYPE } from "../src/core/task-boundary-detector.ts";
import type { TaskPlan } from "../src/core/task-plan.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
		taskPlan: manager.getTaskPlan(),
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
		rmSync(root, { recursive: true, force: true });
	});

	/** An earlier task (promoted, checkpointed), a task boundary, the current task with its plan, then a compaction keeping its last turn. */
	function longSession() {
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
		manager.setTaskPlan(plan("second task"));
		const answer = manager.appendMessage(assistant("second answer"));
		manager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, { taskSummary: "second task", beforeEntryId: anchor });
		manager.appendCustomEntry(TASK_DESCRIPTOR_CUSTOM_TYPE, { descriptor: "second task" });
		manager.appendPromotedRange(first, answer);
		manager.writeWorkingNote("current note");
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
		manager.setTaskPlan(plan("earlier task"));
		manager.appendMessage(user("earlier"));
		manager.appendMessage(assistant("done"));
		const anchor = manager.appendMessage(user("new task"));
		manager.appendMessage(assistant("on it"));
		manager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, { taskSummary: "new task", beforeEntryId: anchor });
		manager.appendCompaction("summary", anchor, 100);
		expect(manager.getTaskPlan()).toBeUndefined();

		manager.rotate();

		expect(manager.getTaskPlan()).toBeUndefined();
		expect(readFileSync(manager.getSessionFile() as string, "utf8")).not.toContain("earlier task");
	});

	it("rotates on its own at a compaction once the log reaches the size limit", () => {
		const manager = SessionManager.create(root, sessionDir, key);
		manager.appendMessage(user("start"));
		manager.appendMessage(assistant("ok"));
		manager.appendCustomEntry("filler", "x".repeat(SESSION_ROTATE_BYTES));
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

	it("does nothing for a session that is not persisted", () => {
		const manager = SessionManager.inMemory(root);
		manager.appendMessage(user("hi"));
		manager.appendMessage(assistant("hello"));

		expect(manager.rotate()).toBeUndefined();
	});
});
