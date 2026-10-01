/**
 * Session-side Task Plan support (issue #382), installed by agent-session.ts on the main agent only
 * (sub-agents report to it; its plan covers their work). The plan is optional: nothing here blocks a
 * file change or holds a run open for a plan.
 *   - beforeToolCall: while a plan is open, each file is snapshotted before its first change so the
 *     reviewer can see a diff even outside git;
 *   - beforeStop: claim check, then one independent review of a plan the model finished;
 *   - planStatus: the one-line plan status the channel appends to the final reply.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { AgentMessage, BeforeToolCallResult } from "theoses-agent-core";
import { claimCheck, FINAL_REPLY_NOTE } from "./claim-check.ts";
import { createCustomMessage } from "./messages.ts";
import { formatFindings, logReview, PLAN_REVIEW_CUSTOM_TYPE, type ReviewOutcome } from "./plan-reviewer.ts";
import { formatPlanStatus, isPlanOpen, needsReview, runTouchedPlan, type TaskPlan, verifyOutput } from "./task-plan.ts";
import { checkAfterLastChange, fileChangesOf, firstLine, textOf, toolRuns } from "./tool-runs.ts";
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
		locations: string[];
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
	/** Directories outside cwd that this plan changed, so the reviewer looks there (2026-09-28). */
	private outsideDirs = new Set<string>();
	private snapshotPlan: string | undefined;
	private planAtOperationStart: string | undefined;
	private pendingReviewOutcome: { goal: string; items: number; mustFix: number } | undefined;

	constructor(deps: TaskPlanGuardDeps) {
		this.deps = deps;
	}

	/** While a plan is open, snapshots the files a tool call is about to change. Never blocks. */
	beforeToolCall(toolName: string, args: Record<string, unknown>): BeforeToolCallResult | undefined {
		if (!this.deps.enabled()) return undefined;
		const changes = fileChangesOf(toolName, args, this.deps.cwd, [...this.snapshots.keys()]);
		if (!changes) return undefined;
		const { paths, dirs, untraced } = changes;

		// ponytail: changes made before the model opens a plan are not snapshotted, so the reviewer's diff
		// starts at plan creation; snapshot every change and key by plan if that gap matters.
		const plan = this.deps.getPlan();
		if (!plan || !isPlanOpen(plan)) return undefined;

		if (this.snapshotPlan !== plan.createdAt) {
			this.snapshotPlan = plan.createdAt;
			this.snapshots = new Map();
			this.untracedCommands = [];
			this.outsideDirs = new Set();
		}
		for (const path of paths) {
			const absolute = resolveToCwd(path, this.deps.cwd);
			if (!this.snapshots.has(absolute)) this.snapshots.set(absolute, readSnapshot(absolute));
			if (this.isOutside(absolute)) this.outsideDirs.add(dirname(absolute));
		}
		for (const dir of dirs) {
			const absolute = resolveToCwd(dir, this.deps.cwd);
			if (this.isOutside(absolute)) this.outsideDirs.add(absolute);
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
			const shown = this.isOutside(path) ? path : relative(this.deps.cwd, path) || path;
			parts.push(this.deps.generatePatch(shown, before ?? "", after ?? ""));
		}
		if (this.untracedCommands.length > 0) {
			parts.push(
				`Commands that changed files in ways the harness could not trace:\n${this.untracedCommands.map((c) => `$ ${c}`).join("\n")}`,
			);
		}
		return parts.join("\n");
	}

	/** Directories outside cwd this plan changed, sorted. */
	locations(): string[] {
		return [...this.outsideDirs].sort();
	}

	private isOutside(path: string): boolean {
		const rel = relative(this.deps.cwd, path);
		return rel.startsWith("..") || isAbsolute(rel);
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
		const planUsed =
			toolRuns(run).some((tool) => tool.name === "task_plan") ||
			JSON.stringify(plan ?? null) !== this.planAtOperationStart;
		let latestVerify =
			planUsed && !plan?.abandoned ? plan?.items.filter((item) => item.kind === "verify").at(-1) : undefined;
		const checks = checkAfterLastChange(
			toolRuns(run),
			latestVerify?.verifyCommand,
			this.deps.cwd,
			latestVerify?.verifyAfter,
		);
		// Earlier stages keep their historical evidence. The final gate must be fresh when more source changes land.
		if (
			plan &&
			!plan.abandoned &&
			latestVerify &&
			latestVerify.status !== "open" &&
			checks.changed &&
			(!latestVerify.evidence || checks.lastCheck?.id !== latestVerify.evidence.toolCallId)
		) {
			plan = {
				...plan,
				items: plan.items.map((item) =>
					item.id === latestVerify?.id ? { ...item, status: "open", evidence: undefined } : item,
				),
			};
			this.deps.setPlan(plan);
			latestVerify = plan.items.find((item) => item.id === latestVerify?.id);
		}
		const verifyCovered =
			plan !== undefined &&
			!plan.abandoned &&
			latestVerify?.status !== "open" &&
			latestVerify?.evidence !== undefined;

		const claim = claimCheck(run, { verifyCovered, verifyCommand: latestVerify?.verifyCommand, cwd: this.deps.cwd });
		if (claim) return [claim];
		if (!enabled) return [];

		const reviewedThisRun = run.some((m) => m.role === "custom" && m.customType === PLAN_REVIEW_CUSTOM_TYPE);
		if (!reviewedThisRun && planUsed && runTouchedPlan(run) && needsReview(plan)) {
			const outcome = await this.deps.review({
				plan,
				diff: this.diff(),
				verifyOutput: verifyOutput(plan),
				locations: this.locations(),
			});
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
	return createCustomMessage(
		customType,
		`[System: ${label}]\n${text}\n\n${FINAL_REPLY_NOTE}`,
		true,
		undefined,
		new Date().toISOString(),
	);
}
