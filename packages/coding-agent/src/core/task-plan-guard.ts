/**
 * Session-side Task Plan enforcement (issue #382), installed by agent-session.ts on the main agent only
 * (sub-agents report to it; its plan covers their work):
 *   - beforeToolCall: a file change (edit, write, or a shell command that changes files) needs an open
 *     plan, and each file is snapshotted before its first change so the reviewer can see a diff even
 *     outside git;
 *   - beforeStop: claim check, then open-item push-backs, then one independent review;
 *   - planStatus: the one-line plan status the channel appends to the final reply.
 */
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { AgentMessage, BeforeToolCallResult } from "theoses-agent-core";
import { claimCheck } from "./claim-check.ts";
import { createCustomMessage } from "./messages.ts";
import { formatFindings, logReview, PLAN_REVIEW_CUSTOM_TYPE, type ReviewOutcome } from "./plan-reviewer.ts";
import {
	formatPlan,
	formatPlanStatus,
	isPlanOpen,
	needsReview,
	planStopCheck,
	runTouchedPlan,
	TASK_PLAN_CHECK_CUSTOM_TYPE,
	type TaskPlan,
	verifyOutput,
} from "./task-plan.ts";
import { COMMAND_TOOLS, commandEffect, FILE_TOOLS, firstLine, textOf } from "./tool-runs.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/** Files bigger than this are listed in the diff by name only. */
const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface TaskPlanGuardDeps {
	cwd: string;
	getPlan: () => TaskPlan | undefined;
	setPlan: (plan: TaskPlan) => void;
	enabled: () => boolean;
	/** Messages of the current run (since the last user message). */
	runMessages: () => AgentMessage[];
	review: (input: {
		plan: TaskPlan;
		diff: string;
		verifyOutput: string | undefined;
	}) => Promise<ReviewOutcome | { skipped: string }>;
	generatePatch: (path: string, before: string, after: string) => string;
}

function readSnapshot(path: string): string | null {
	try {
		if (statSync(path).size > MAX_SNAPSHOT_BYTES) return `[file larger than ${MAX_SNAPSHOT_BYTES} bytes]`;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export class TaskPlanGuard {
	private readonly deps: TaskPlanGuardDeps;
	// ponytail: snapshots live in memory, so a restart mid-plan loses the "before" side and the reviewer sees files as new; persist them if that matters.
	private snapshots = new Map<string, string | null>();
	private untracedCommands: string[] = [];
	private snapshotPlan: string | undefined;
	private planAtOperationStart: string | undefined;
	private pendingReviewOutcome: { goal: string; items: number; mustFix: number } | undefined;

	constructor(deps: TaskPlanGuardDeps) {
		this.deps = deps;
	}

	/** Refuses a file change without an open plan; snapshots the files it is about to change. */
	beforeToolCall(toolName: string, args: Record<string, unknown>): BeforeToolCallResult | undefined {
		if (!this.deps.enabled()) return undefined;
		let paths: string[];
		let untraced: string | undefined;
		if (FILE_TOOLS.has(toolName) && typeof args.path === "string") {
			paths = [args.path];
		} else if (COMMAND_TOOLS.has(toolName) && typeof args.command === "string") {
			const effect = commandEffect(args.command);
			if (!effect.changesFiles) return undefined;
			paths = effect.paths;
			if (effect.unknownChange) untraced = args.command;
		} else {
			return undefined;
		}

		const plan = this.deps.getPlan();
		if (!plan || !isPlanOpen(plan)) {
			const reason =
				plan && !plan.abandoned
					? `Blocked: this changes files, but your task plan is closed.\n${formatPlan(plan)}\nIf this is more work on the same task, task_plan add an item for it first; if it is a new task, task_plan create a new plan.`
					: 'Blocked: create a task plan before changing files. Call task_plan with action "create": the goal, one item per file/stage/config this task touches, a verify check that runs the changed code, and kind "fix" if you are correcting something broken.';
			return { block: true, reason };
		}

		if (this.snapshotPlan !== plan.createdAt) {
			this.snapshotPlan = plan.createdAt;
			this.snapshots = new Map();
			this.untracedCommands = [];
		}
		for (const path of paths) {
			const absolute = resolveToCwd(path, this.deps.cwd);
			if (!this.snapshots.has(absolute)) this.snapshots.set(absolute, readSnapshot(absolute));
		}
		if (untraced) this.untracedCommands.push(firstLine(untraced, 300));
		return undefined;
	}

	/** Diff of every snapshotted file against its current contents, plus untraceable commands. */
	diff(): string {
		const parts: string[] = [];
		for (const [path, before] of this.snapshots) {
			const after = readSnapshot(path);
			if (after === before) continue;
			const shown = relative(this.deps.cwd, path) || path;
			parts.push(this.deps.generatePatch(shown, before ?? "", after ?? ""));
		}
		if (this.untracedCommands.length > 0) {
			parts.push(
				`Commands that changed files in ways the harness could not trace:\n${this.untracedCommands.map((c) => `$ ${c}`).join("\n")}`,
			);
		}
		return parts.join("\n");
	}

	/** Marks the start of a user operation, so planStatus only reports plans this operation touched. */
	startOperation(): void {
		this.planAtOperationStart = JSON.stringify(this.deps.getPlan() ?? null);
	}

	/** The status line for the final reply, when this operation created or changed the plan. */
	planStatus(): string | undefined {
		if (!this.deps.enabled()) return undefined;
		const plan = this.deps.getPlan();
		if (!plan || JSON.stringify(plan) === this.planAtOperationStart) return undefined;
		return formatPlanStatus(plan);
	}

	async beforeStop(): Promise<AgentMessage[]> {
		const run = this.deps.runMessages();
		const enabled = this.deps.enabled();
		let plan = enabled ? this.deps.getPlan() : undefined;
		const verifyCovered =
			plan !== undefined &&
			!plan.abandoned &&
			runTouchedPlan(run) &&
			plan.items.some((item) => item.kind === "verify");

		const claim = claimCheck(run, { verifyCovered });
		if (claim) return [claim];
		if (!enabled) return [];

		const stop = planStopCheck(plan, run);
		if (stop.plan) {
			this.deps.setPlan(stop.plan);
			plan = stop.plan;
		}
		if (stop.problem) {
			return [push(TASK_PLAN_CHECK_CUSTOM_TYPE, "task plan check", stop.problem)];
		}
		if (stop.gaveUp && plan) {
			console.error(`[task-plan] ended with open items: ${firstLine(formatPlan(plan).replace(/\n/g, " | "), 300)}`);
		}

		const reviewedThisRun = run.some((m) => m.role === "custom" && m.customType === PLAN_REVIEW_CUSTOM_TYPE);
		if (!reviewedThisRun && runTouchedPlan(run) && needsReview(plan)) {
			const outcome = await this.deps.review({ plan, diff: this.diff(), verifyOutput: verifyOutput(run) });
			if ("skipped" in outcome) {
				this.deps.setPlan({ ...plan, review: { skipped: outcome.skipped } });
				logReview({ phase: "skipped", goal: plan.goal, kind: plan.kind, reason: outcome.skipped });
				return [];
			}
			this.deps.setPlan({
				...plan,
				review: { model: outcome.model, verdict: outcome.verdict, mustFix: outcome.mustFix.length },
			});
			logReview({
				phase: "review",
				goal: plan.goal,
				kind: plan.kind,
				items: plan.items.length,
				model: outcome.model,
				verdict: outcome.verdict,
				mustFix: outcome.mustFix,
				nits: outcome.nits,
				inputTokens: outcome.inputTokens,
				outputTokens: outcome.outputTokens,
				cost: outcome.cost,
			});
			if (outcome.verdict === "gaps") {
				this.pendingReviewOutcome = {
					goal: plan.goal,
					items: plan.items.length,
					mustFix: outcome.mustFix.length,
				};
				return [push(PLAN_REVIEW_CUSTOM_TYPE, "independent review", formatFindings(outcome))];
			}
			return [];
		}

		if (this.pendingReviewOutcome && reviewedThisRun) {
			// What the worker did with the findings, for the hit-rate check: items added means it acted on them.
			const reply = [...run].reverse().find((m) => m.role === "assistant");
			logReview({
				phase: "outcome",
				goal: this.pendingReviewOutcome.goal,
				mustFix: this.pendingReviewOutcome.mustFix,
				itemsAdded: (plan?.items.length ?? 0) - this.pendingReviewOutcome.items,
				reply: reply && reply.role === "assistant" ? textOf(reply.content).slice(0, 500) : "",
			});
			this.pendingReviewOutcome = undefined;
		}
		return [];
	}
}

function push(customType: string, label: string, text: string): AgentMessage {
	console.error(`[${customType}] ${firstLine(text)}`);
	return createCustomMessage(customType, `[System: ${label}]\n${text}`, true, undefined, new Date().toISOString());
}
