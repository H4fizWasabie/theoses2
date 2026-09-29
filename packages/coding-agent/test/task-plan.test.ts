import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPrompt, PLAN_REVIEW_CUSTOM_TYPE, parseReview, type ReviewOutcome } from "../src/core/plan-reviewer.ts";
import {
	applyPlanAction,
	formatPlanStatus,
	needsReview,
	type TaskPlan,
	type TaskPlanInput,
} from "../src/core/task-plan.ts";
import { TaskPlanGuard } from "../src/core/task-plan-guard.ts";
import { commandEffect } from "../src/core/tool-runs.ts";
import { generateUnifiedPatch } from "../src/core/tools/edit-diff.ts";

let nextId = 0;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function reply(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function tool(name: string, args: Record<string, unknown>, output: string, isError = false): AgentMessage[] {
	const id = `call-${nextId++}`;
	const call = reply("");
	if (call.role === "assistant") call.content = [{ type: "toolCall", id, name, arguments: args }];
	return [
		call,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError,
			timestamp: 0,
		},
	];
}

function act(plan: TaskPlan | undefined, input: TaskPlanInput, runMessages: AgentMessage[] = []) {
	return applyPlanAction(plan, input, { runMessages, request: "switch run.sh to one image", now: new Date(0) });
}

function created(input: Partial<TaskPlanInput> = {}): TaskPlan {
	const result = act(undefined, {
		action: "create",
		goal: "g",
		items: ["carousel.py", "run.sh"],
		verify: "dry run",
		...input,
	});
	if (!result.plan) throw new Error(result.error);
	return result.plan;
}

describe("commandEffect", () => {
	it.each([
		["sed -i '105d' tools/run.sh", ["tools/run.sh"]],
		["sed -i -e 's/a/b/' x.py y.py", ["x.py", "y.py"]],
		["echo hi > notes.md", ["notes.md"]],
		["cat >> log.txt <<'EOF'\nline > with arrow\nEOF", ["log.txt"]],
		["cp a.sh dest/b.sh", ["dest/b.sh"]],
		["mv a b", ["a", "b"]],
		["rm -f old.json && ls", ["old.json"]],
		["make build 2>&1 | tee build.log", ["build.log"]],
	])("%s changes %j", (command, paths) => {
		expect(commandEffect(command)).toMatchObject({ changesFiles: true, paths });
	});

	it.each([
		"grep -rn foo src",
		"cat a.txt | head -5",
		"cd pkg && git status && git diff",
		"sed -n '1,20p' a.ts",
		"find . -name '*.ts' 2>/dev/null",
	])("%s only reads", (command) => {
		expect(commandEffect(command)).toMatchObject({ readOnly: true, changesFiles: false });
	});

	it.each([
		"npm test > /tmp/out.txt",
		"f=$(mktemp) && curl -s url > $f",
		'node -e "const f = (a) => a > 1"',
		"bash tools/run.sh --dry-run 2>&1 | tail -12",
	])("%s runs something without changing files", (command) => {
		expect(commandEffect(command)).toMatchObject({ readOnly: false, changesFiles: false });
	});

	it("flags a python heredoc that writes files as an untraced change", () => {
		const effect = commandEffect("python3 - <<'EOF'\nopen('run.sh','w').write(s)\nEOF");
		expect(effect).toMatchObject({ changesFiles: true, unknownChange: true, paths: [], dirs: [] });
	});

	it("reads paths after a cd relative to it, and records where an untraced change ran", () => {
		expect(commandEffect("cd /srv/app && sed -i 's/a/b/' tools/run.sh")).toMatchObject({
			paths: ["/srv/app/tools/run.sh"],
			dirs: ["/srv/app"],
		});
		const untraced = commandEffect("cd /srv/reels && python3 - <<'EOF'\nopen('addvoice.sh','w').write(s)\nEOF");
		expect(untraced).toMatchObject({ unknownChange: true, paths: [], dirs: ["/srv/reels"] });
		expect(commandEffect("cd /srv/app && git status")).toMatchObject({ readOnly: true, dirs: [] });
		expect(commandEffect("cd /tmp/x && echo hi > out.txt")).toMatchObject({ changesFiles: false, dirs: [] });
	});
});

describe("applyPlanAction", () => {
	it("create needs a goal and a verify check, and ends with the verify item", () => {
		expect(act(undefined, { action: "create", goal: "g" }).error).toContain("verify");
		const plan = created();
		expect(plan.items.map((i) => [i.kind, i.status])).toEqual([
			["step", "open"],
			["step", "open"],
			["verify", "open"],
		]);
		expect(plan.request).toBe("switch run.sh to one image");
	});

	it("a fix starts with root cause, siblings and fix scope, which close with content only", () => {
		const plan = created({ kind: "fix", items: ["patch"] });
		expect(plan.items.map((i) => i.kind)).toEqual(["root-cause", "siblings", "fix-scope", "step", "verify"]);
		expect(act(plan, { action: "update", id: 1, status: "done" }).error).toContain("not a tick");
		const note = "the gate still assumed a carousel after the redesign";
		expect(act(plan, { action: "update", id: 1, status: "done", note }).plan?.items[0]).toMatchObject({
			status: "done",
			note,
		});
	});

	it("refuses a second plan while one is open", () => {
		expect(act(created(), { action: "create", goal: "other", verify: "x" }).error).toContain("already open");
	});

	it("closes a verify item only after a check passed since the last file change", () => {
		const plan = created();
		const edited = [user("go"), ...tool("edit", { path: "run.sh" }, "ok")];
		expect(act(plan, { action: "update", id: 3, status: "done" }, edited).error).toContain("no check command");
		const readOnly = [...edited, ...tool("bash", { command: "grep -n gate run.sh" }, "12: gate")];
		expect(act(plan, { action: "update", id: 3, status: "done" }, readOnly).error).toContain("no check command");
		const failed = [...edited, ...tool("bash", { command: "bash run.sh --dry-run" }, "FAILURE: gate 1", true)];
		expect(act(plan, { action: "update", id: 3, status: "done" }, failed).error).toContain("FAILURE: gate 1");
		const passed = [...edited, ...tool("bash", { command: "bash run.sh --dry-run" }, "gates passed")];
		expect(act(plan, { action: "update", id: 3, status: "done" }, passed).plan?.items[2].status).toBe("done");
	});

	it("defers a verify item only with a reason and after the closest local check passed", () => {
		const plan = created();
		const passed = [
			user("go"),
			...tool("edit", { path: "run.sh" }, "ok"),
			...tool("bash", { command: "bash run.sh --dry-run" }, "ok"),
		];
		expect(act(plan, { action: "update", id: 3, status: "deferred" }, passed).error).toContain("reason");
		expect(act(plan, { action: "update", id: 3, status: "deferred", note: "real publish at 02:00" }).error).toContain(
			"no check command",
		);
		const deferred = act(
			plan,
			{ action: "update", id: 3, status: "deferred", note: "real publish at 02:00" },
			passed,
		);
		expect(deferred.plan?.items[2]).toMatchObject({ status: "deferred", note: "real publish at 02:00" });
	});

	it("drops a deferral reason when the item is later closed without a note (#388)", () => {
		const plan = created();
		const deferred = act(plan, { action: "update", id: 2, status: "deferred", note: "blocked on abah's OK" }).plan;
		if (!deferred) throw new Error("defer failed");
		expect(act(deferred, { action: "update", id: 2, status: "done" }).plan?.items[1]).toEqual({
			id: 2,
			kind: "step",
			text: "run.sh",
			status: "done",
			note: undefined,
		});
		const withNote = act(plan, { action: "update", id: 1, note: "carousel gate at line 105" }).plan;
		if (!withNote) throw new Error("note failed");
		expect(act(withNote, { action: "update", id: 1, status: "done" }).plan?.items[0].note).toBe(
			"carousel gate at line 105",
		);
	});

	it("caps the plan size", () => {
		const items = Array.from({ length: 12 }, (_, i) => `step ${i}`);
		expect(act(undefined, { action: "create", goal: "g", items, verify: "v" }).error).toContain("At most 12");
	});

	it("add after every verify item is closed needs a `verify`, and appends a new open verify item with it (#387)", () => {
		const plan = created({ items: [] });
		const closed: TaskPlan = { ...plan, items: plan.items.map((i) => ({ ...i, status: "done" as const })) };
		expect(act(closed, { action: "add", items: ["step x"] }).error).toContain("verify");
		const added = act(closed, { action: "add", items: ["step x"], verify: "check x" }).plan;
		expect(added?.items.map((i) => [i.id, i.kind, i.status])).toEqual([
			[1, "verify", "done"],
			[2, "step", "open"],
			[3, "verify", "open"],
		]);
	});

	it("add while a verify item is still open works without `verify`, as before", () => {
		const plan = created();
		const added = act(plan, { action: "add", items: ["extra step"] }).plan;
		expect(added?.items.map((i) => [i.id, i.kind, i.status])).toEqual([
			[1, "step", "open"],
			[2, "step", "open"],
			[3, "verify", "open"],
			[4, "step", "open"],
		]);
	});

	it("caps count the extra verify item that add appends once verification is closed", () => {
		const items = Array.from({ length: 10 }, (_, i) => `step ${i}`);
		const plan = created({ items });
		const closed: TaskPlan = {
			...plan,
			items: plan.items.map((i) => (i.kind === "verify" ? { ...i, status: "done" as const } : i)),
		};
		expect(act(closed, { action: "add", items: ["one more"], verify: "v2" }).error).toContain("At most 12");
	});
});

describe("task plan replays", () => {
	it("replays 2026-09-27: steps added after the render gate closed need their own verify, and closing it doesn't touch the render gate (#387)", () => {
		const items = [
			{ id: 1, kind: "step" as const, text: "render 02", status: "done" as const },
			{ id: 2, kind: "step" as const, text: "thumbnail", status: "done" as const },
			{ id: 3, kind: "step" as const, text: "captions", status: "done" as const },
			{ id: 4, kind: "step" as const, text: "audio mix", status: "done" as const },
			{ id: 5, kind: "verify" as const, text: "tools/run-video.sh 02 --dry-run", status: "done" as const },
		];
		const base: TaskPlan = {
			kind: "change",
			goal: "ai-third-person part 02",
			request: "publish part 02",
			items,
			createdAt: new Date(0).toISOString(),
		};

		expect(
			act(base, { action: "add", items: ["publish to Threads/FB", "append ledger + edit Status line"] }).error,
		).toContain("verify");

		const added = act(base, {
			action: "add",
			items: ["publish to Threads/FB", "append ledger + edit Status line"],
			verify: "node tools/check-ledger.mjs 02",
		}).plan;
		if (!added) throw new Error("add failed");
		expect(added.items.map((i) => [i.id, i.kind, i.status])).toEqual([
			[1, "step", "done"],
			[2, "step", "done"],
			[3, "step", "done"],
			[4, "step", "done"],
			[5, "verify", "done"],
			[6, "step", "open"],
			[7, "step", "open"],
			[8, "verify", "open"],
		]);

		const ledgerChange = [
			user("publish part 02"),
			...tool("bash", { command: 'cat >> state/ledger.jsonl <<\'EOF\'\n{"post":"02"}\nEOF' }, "ok"),
			reply("Posted."),
		];
		const passed = [
			...ledgerChange,
			...tool("bash", { command: "node tools/check-ledger.mjs 02" }, "ledger has 02, Status: posted"),
		];
		const closed = act(added, { action: "update", id: 8, status: "done" }, passed);
		expect(closed.plan?.items[7]).toMatchObject({ id: 8, status: "done" });
		expect(closed.plan?.items[4]).toMatchObject({ id: 5, status: "done" });
	});
});

describe("formatPlanStatus / needsReview", () => {
	it("shows each item and the review in one line", () => {
		const plan = created();
		const closed: TaskPlan = {
			...plan,
			items: plan.items.map((i) =>
				i.kind === "verify"
					? { ...i, status: "deferred" as const, note: "real publish at 02:00" }
					: { ...i, status: "done" as const },
			),
			review: { model: "openai/gpt-6-luna", verdict: "ok", mustFix: 0 },
		};
		expect(formatPlanStatus(closed)).toBe(
			"✓ carousel.py · ✓ run.sh · ⏸ dry run (real publish at 02:00) · reviewed by openai/gpt-6-luna: no gaps",
		);
	});

	it("reviews closed fixes and multi-item changes, once", () => {
		const oneItem = created({ items: [] });
		const close = (p: TaskPlan): TaskPlan => ({
			...p,
			items: p.items.map((i) => ({ ...i, status: "done" as const })),
		});
		expect(needsReview(close(oneItem))).toBe(false);
		expect(needsReview(close(created()))).toBe(true);
		expect(needsReview(created())).toBe(false);
		expect(needsReview({ ...close(created()), review: { skipped: "timeout" } })).toBe(false);
	});
});

describe("buildPrompt", () => {
	it("lists deferred items as accepted deferrals for the reviewer (#386)", () => {
		const plan = created();
		const closed: TaskPlan = {
			...plan,
			items: plan.items.map((i) =>
				i.id === 2
					? { ...i, status: "deferred" as const, note: "waiting for abah's OK" }
					: { ...i, status: "done" as const },
			),
		};
		expect(buildPrompt(closed, "", undefined)).toContain(
			"<accepted_deferrals>\n- [2] run.sh — reason: waiting for abah's OK\n</accepted_deferrals>",
		);
		expect(buildPrompt(plan, "", undefined)).not.toContain("<accepted_deferrals>");
	});

	it("points the reviewer at directories outside its starting directory", () => {
		const prompt = buildPrompt(created(), "", undefined, ["/home/theoses/icm-workspaces/labnotebook-reels"]);
		expect(prompt).toContain("<change_locations>");
		expect(prompt).toContain("- /home/theoses/icm-workspaces/labnotebook-reels");
		expect(buildPrompt(created(), "", undefined)).not.toContain("<change_locations>");
	});
});

describe("parseReview", () => {
	it("reads the verdict JSON out of surrounding prose", () => {
		const parsed = parseReview(
			'Here you go:\n{"verdict":"gaps","findings":[{"severity":"must-fix","file":"run.sh","issue":"gate still expects 2-10","evidence":"run.sh:109"},{"severity":"style","issue":"naming"}]}',
		);
		expect(parsed?.verdict).toBe("gaps");
		expect(parsed?.findings.map((f) => f.severity)).toEqual(["must-fix", "nit"]);
	});

	it("rejects anything without a valid verdict", () => {
		expect(parseReview("looks fine")).toBeUndefined();
		expect(parseReview('{"verdict":"maybe"}')).toBeUndefined();
	});
});

describe("TaskPlanGuard", () => {
	let dir: string;
	let plan: TaskPlan | undefined;
	let run: AgentMessage[];
	let reviews: { diff: string; verifyOutput: string | undefined; locations: string[] }[];
	let reviewResult: ReviewOutcome | { skipped: string };

	function guard(enabled = true): TaskPlanGuard {
		return new TaskPlanGuard({
			cwd: dir,
			getPlan: () => plan,
			setPlan: (next) => {
				plan = next;
			},
			enabled: () => enabled,
			runMessages: () => run,
			review: async (input) => {
				reviews.push({ diff: input.diff, verifyOutput: input.verifyOutput, locations: input.locations });
				return reviewResult;
			},
			generatePatch: generateUnifiedPatch,
		});
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "task-plan-guard-"));
		plan = undefined;
		run = [];
		reviews = [];
		reviewResult = { model: "luna", verdict: "ok", mustFix: [], nits: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("never blocks a file change, with or without a plan", () => {
		const g = guard();
		expect(g.beforeToolCall("edit", { path: "run.sh" })).toBeUndefined();
		expect(g.beforeToolCall("bash", { command: "sed -i '105d' run.sh" })).toBeUndefined();
		plan = created();
		expect(g.beforeToolCall("edit", { path: "run.sh" })).toBeUndefined();
		plan = { ...plan, items: plan.items.map((i) => ({ ...i, status: "done" as const })) };
		expect(g.beforeToolCall("write", { path: "new.ts" })).toBeUndefined();
	});

	it("snapshots files only while a plan is open", () => {
		const file = join(dir, "run.sh");
		writeFileSync(file, "before\n");
		const g = guard();
		g.beforeToolCall("edit", { path: "run.sh" });
		writeFileSync(file, "after-no-plan\n");
		expect(g.diff()).toBe("");
		plan = created();
		g.beforeToolCall("edit", { path: "run.sh" });
		writeFileSync(file, "after-plan\n");
		expect(g.diff()).toContain("-after-no-plan");
		expect(g.diff()).toContain("+after-plan");
	});

	it("does nothing when disabled", async () => {
		const g = guard(false);
		expect(g.beforeToolCall("edit", { path: "run.sh" })).toBeUndefined();
		plan = created();
		run = [user("go"), ...tool("edit", { path: "run.sh" }, "ok"), reply("Done.")];
		expect(await g.beforeStop()).toEqual([]);
	});

	it("replays 2026-09-26: the failed edit is flagged, and the open item shows in the status instead of holding the run", async () => {
		const g = guard();
		plan = created();
		run = [
			user("switch run.sh to one image"),
			...tool("edit", { path: "carousel.py" }, "ok"),
			...tool("edit", { path: "run.sh" }, "No changes applied: all 5 edits were rejected.", true),
			...tool("bash", { command: "bash tools/run.sh --dry-run" }, "[dry-run] nothing published"),
			reply("Done and verified — gate changed to exactly 1 image."),
		];
		const [first] = await g.beforeStop();
		expect(first).toMatchObject({ customType: "claim-check" });
		run = [...run, first, reply("Done and verified.")];
		expect(await g.beforeStop()).toEqual([]);
		expect(reviews).toHaveLength(0);
		expect(g.planStatus()).toContain("☐ run.sh");
	});

	it("reviews a closed plan once with a diff from snapshots, and pushes must-fix findings", async () => {
		const file = join(dir, "run.sh");
		writeFileSync(file, "gate 2-10\n");
		const g = guard();
		plan = created();
		g.startOperation();
		expect(g.beforeToolCall("edit", { path: "run.sh" })).toBeUndefined();
		writeFileSync(file, "gate 1\n");
		plan = { ...plan, items: plan.items.map((i) => ({ ...i, status: "done" as const })) };
		run = [
			user("go"),
			...tool("task_plan", {}, "plan"),
			...tool("edit", { path: "run.sh" }, "ok"),
			...tool("bash", { command: "bash run.sh --dry-run" }, "gates passed"),
			reply("Done."),
		];
		reviewResult = {
			model: "luna",
			verdict: "gaps",
			mustFix: [{ severity: "must-fix", file: "run.sh", issue: "publish still uses the carousel container" }],
			nits: 0,
			inputTokens: 1,
			outputTokens: 1,
			cost: 0,
		};

		const [pushed] = await g.beforeStop();
		expect(pushed).toMatchObject({ customType: PLAN_REVIEW_CUSTOM_TYPE });
		expect(reviews[0].diff).toContain("-gate 2-10");
		expect(reviews[0].diff).toContain("+gate 1");
		expect(reviews[0].verifyOutput).toContain("gates passed");
		expect(plan?.review).toEqual({ model: "luna", verdict: "gaps", mustFix: 1 });

		run = [...run, pushed, reply("Fixed the publish call too.")];
		expect(await g.beforeStop()).toEqual([]);
		expect(reviews).toHaveLength(1);
		expect(g.planStatus()).toContain("reviewed by luna: 1 gap(s) sent back");
		expect(readFileSync(file, "utf8")).toBe("gate 1\n");
	});

	it("replays 2026-09-28: a change outside cwd reaches the reviewer with absolute paths and its location", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "task-plan-workspace-"));
		try {
			const script = join(workspace, "build.sh");
			writeFileSync(script, "drawtext\n");
			const g = guard();
			plan = created();
			g.startOperation();
			g.beforeToolCall("edit", { path: script });
			writeFileSync(script, "zoompan\n");
			g.beforeToolCall("bash", { command: `cd ${workspace} && python3 - <<'EOF'\nopen('addvoice.sh','w')\nEOF` });
			g.beforeToolCall("edit", { path: "run.sh" });
			plan = { ...plan, items: plan.items.map((i) => ({ ...i, status: "done" as const })) };
			run = [
				user("go"),
				...tool("task_plan", {}, "plan"),
				...tool("edit", { path: script }, "ok"),
				...tool("bash", { command: `bash ${script}` }, "built"),
				reply("Done."),
			];

			await g.beforeStop();
			expect(reviews[0].locations).toEqual([workspace]);
			expect(reviews[0].diff).toContain(script);
			expect(reviews[0].diff).not.toContain("../");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("records a skipped review in the plan status", async () => {
		const g = guard();
		plan = created();
		g.startOperation();
		plan = { ...plan, items: plan.items.map((i) => ({ ...i, status: "done" as const })) };
		run = [user("go"), ...tool("task_plan", {}, "plan"), reply("Done.")];
		reviewResult = { skipped: "timeout" };
		expect(await g.beforeStop()).toEqual([]);
		expect(g.planStatus()).toContain("⚠ not reviewed (timeout)");
	});
});
