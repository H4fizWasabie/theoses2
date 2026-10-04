/**
 * Session-side Task Plan support (issue #382), installed by agent-session.ts on the main agent only
 * (sub-agents report to it; its plan covers their work). The plan is optional: nothing here blocks a
 * file change or holds a run open for a plan.
 *   - beforeStop: claim check, then one independent review of a plan the model finished, with a diff of
 *     what changed since the plan was created, read back from the file checkpoints (so it survives a
 *     restart and works outside git);
 *   - planStatus: the one-line plan status the channel appends to the final reply.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import { claimCheck, FINAL_REPLY_NOTE } from "./claim-check.ts";
import type { Originals } from "./file-checkpoints.ts";
import { createCustomMessage } from "./messages.ts";
import { formatFindings, logReview, PLAN_REVIEW_CUSTOM_TYPE, type ReviewOutcome } from "./plan-reviewer.ts";
import { formatPlanStatus, needsReview, type TaskPlan, verifyOutput } from "./task-plan.ts";
import { fileChangesOf, firstLine, textOf } from "./tool-runs.ts";
import { resolveToCwd } from "./tools/path-utils.ts";
import { readRunEvidence } from "./verification-evidence.ts";

/** Files bigger than this are listed in the diff by name only. */
const MAX_SNAPSHOT_BYTES = 1_000_000;
const TOO_LARGE = `[file larger than ${MAX_SNAPSHOT_BYTES} bytes]`;

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
	/** The files changed since an ISO time, with their content from before (the session's file checkpoints). */
	originalsSince: (since: string) => Originals;
}

function readSnapshot(path: string): string | null {
	try {
		if (statSync(path).size > MAX_SNAPSHOT_BYTES) return TOO_LARGE;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

const NO_ORIGINALS: Originals = { files: [], skipped: [], untraced: [] };

export class TaskPlanGuard {
	private readonly deps: TaskPlanGuardDeps;
	private planAtOperationStart: string | undefined;
	private pendingReviewOutcome: { goal: string; items: number; mustFix: number } | undefined;

	constructor(deps: TaskPlanGuardDeps) {
		this.deps = deps;
	}

	/** What changed since the current plan was created, from the file checkpoints. */
	private originals(): Originals {
		const plan = this.deps.getPlan();
		return plan ? this.deps.originalsSince(plan.createdAt) : NO_ORIGINALS;
	}

	/** Diff of every file changed since the plan was created against its current contents, plus untraceable commands. */
	diff(): string {
		const { files, skipped, untraced } = this.originals();
		const parts: string[] = [];
		const tooLarge: string[] = [];
		for (const { path, before } of files) {
			const after = readSnapshot(path);
			// Either side past the limit cannot be compared, so the file is named rather than silently dropped.
			if (after === TOO_LARGE || (before !== null && Buffer.byteLength(before) > MAX_SNAPSHOT_BYTES)) {
				tooLarge.push(this.shown(path));
				continue;
			}
			if (after === before) continue;
			parts.push(this.deps.generatePatch(this.shown(path), before ?? "", after ?? ""));
		}
		if (tooLarge.length > 0) {
			parts.push(`Files changed but larger than ${MAX_SNAPSHOT_BYTES} bytes, so no diff:\n${tooLarge.join("\n")}`);
		}
		if (skipped.length > 0) {
			parts.push(
				`Files changed whose original was not saved, so no diff:\n${skipped.map((s) => `${this.shown(s.path)} (${s.reason})`).join("\n")}`,
			);
		}
		if (untraced.length > 0) {
			parts.push(
				`Commands that changed files in ways the harness could not trace:\n${untraced.map((c) => `$ ${firstLine(c, 300)}`).join("\n")}`,
			);
		}
		return parts.join("\n");
	}

	/** Directories outside cwd this plan changed, sorted, so the reviewer looks there (2026-09-28). */
	locations(): string[] {
		const { files, skipped, untraced } = this.originals();
		const dirs = new Set<string>();
		for (const { path } of [...files, ...skipped]) {
			if (this.isOutside(path)) dirs.add(dirname(path));
		}
		// An untraced command has no target paths, only the directories it changed files in.
		for (const command of untraced) {
			for (const dir of fileChangesOf("bash", { command }, this.deps.cwd)?.dirs ?? []) {
				const absolute = resolveToCwd(dir, this.deps.cwd);
				if (this.isOutside(absolute)) dirs.add(absolute);
			}
		}
		return [...dirs].sort();
	}

	private shown(path: string): string {
		return this.isOutside(path) ? path : relative(this.deps.cwd, path) || path;
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
		// One reading of the run per stop, so the reopen rule, the claim check and the review trigger agree.
		const evidence = readRunEvidence(run, this.deps.cwd);
		const enabled = this.deps.enabled();
		let plan = enabled ? this.deps.getPlan() : undefined;
		const planUsed = evidence.usedPlanTool || JSON.stringify(plan ?? null) !== this.planAtOperationStart;
		let latestVerify =
			planUsed && !plan?.abandoned ? plan?.items.filter((item) => item.kind === "verify").at(-1) : undefined;
		const lastCheck = evidence.check({ command: latestVerify?.verifyCommand, after: latestVerify?.verifyAfter });
		// Earlier stages keep their historical evidence. The final gate must be fresh when more source changes land.
		if (
			plan &&
			!plan.abandoned &&
			latestVerify &&
			latestVerify.status !== "open" &&
			evidence.changed &&
			(!latestVerify.evidence || lastCheck?.id !== latestVerify.evidence.toolCallId)
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

		const claim = claimCheck(run, {
			verifyCovered,
			verifyCommand: latestVerify?.verifyCommand,
			verifyAfter: latestVerify?.verifyAfter,
			evidence,
		});
		if (claim) return [claim];
		if (!enabled) return [];

		const reviewedThisRun = run.some((m) => m.role === "custom" && m.customType === PLAN_REVIEW_CUSTOM_TYPE);
		if (!reviewedThisRun && planUsed && evidence.touchedPlan && needsReview(plan)) {
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
