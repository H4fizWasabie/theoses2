/**
 * Task Plan (issue #382): the list of everything a change involves, kept by the model through the
 * `task_plan` tool. The model decides whether to use it; the harness never requires a plan and
 * never holds a run open for one. When the model does plan, the plan is held to its own rules.
 *
 * Why: on 2026-09-26 a workspace redesign touched two stages. The model rewrote the first, a failed
 * edit silently dropped the second, and "done" was judged from memory instead of a list. A plan the
 * harness can read turns "half done" into a state it can see:
 *   - a `fix` plan starts with root cause / siblings / fix scope, so a fix looks past the symptom;
 *   - a verify item is only accepted once a check command passed after the last file change;
 *   - open or deferred items show in the status line under the final reply.
 * A finished multi-item plan or fix gets one independent review (plan-reviewer.ts).
 *
 * The plan was mandatory until 2026-09-29: no file change without one, no end of run with open items.
 * Both forced a plan and extra round trips onto small tasks, so the model now chooses.
 *
 * State lives in the session as `task_plan` custom entries (latest wins), so it survives restarts and
 * "continue". Pure functions only; the session wiring is in agent-session.ts.
 */
import type { AgentMessage } from "theoses-agent-core";
import { checkAfterLastChange, firstLine, runChangesFiles, toolRuns } from "./tool-runs.ts";

export const TASK_PLAN_ENTRY_TYPE = "task_plan";
export const MAX_PLAN_ITEMS = 12;
/** Fix-item notes shorter than this are a tick, not an analysis. */
const MIN_FIX_NOTE_CHARS = 20;

export type PlanKind = "change" | "fix";
export type PlanItemKind = "step" | "verify" | "root-cause" | "siblings" | "fix-scope";
export type PlanItemStatus = "open" | "done" | "deferred";

export interface PlanItem {
	id: number;
	kind: PlanItemKind;
	text: string;
	status: PlanItemStatus;
	note?: string;
}

export type PlanReview = { model: string; verdict: "ok" | "gaps"; mustFix: number } | { skipped: string };

export interface TaskPlan {
	kind: PlanKind;
	goal: string;
	/** The user request the plan was created for, for the reviewer. */
	request: string;
	items: PlanItem[];
	createdAt: string;
	abandoned?: string;
	review?: PlanReview;
}

export interface TaskPlanInput {
	action: "create" | "add" | "update" | "abandon" | "show";
	kind?: PlanKind;
	goal?: string;
	items?: string[];
	verify?: string;
	id?: number;
	status?: "done" | "deferred" | "open";
	note?: string;
	reason?: string;
}

const FIX_ITEMS: { kind: PlanItemKind; text: string }[] = [
	{ kind: "root-cause", text: "Root cause: why it broke, not just where it failed" },
	{
		kind: "siblings",
		text: "Siblings: everything else that relies on the same assumption (note the search you ran)",
	},
	{ kind: "fix-scope", text: "Fix scope: every sibling fixed, or ruled out with a reason" },
];

export function openItems(plan: TaskPlan | undefined): PlanItem[] {
	if (!plan || plan.abandoned) return [];
	return plan.items.filter((item) => item.status === "open");
}

/** A plan that still has work in it. */
export function isPlanOpen(plan: TaskPlan | undefined): boolean {
	return openItems(plan).length > 0;
}

/** The reviewer runs once per plan, after every item is closed, on fixes and multi-item changes. */
export function needsReview(plan: TaskPlan | undefined): plan is TaskPlan {
	if (!plan || plan.abandoned || plan.review || isPlanOpen(plan)) return false;
	return plan.kind === "fix" || plan.items.length >= 2;
}

const STATUS_MARK: Record<PlanItemStatus, string> = { open: "☐", done: "✓", deferred: "⏸" };

/** Full plan, for tool results and push-back messages. */
export function formatPlan(plan: TaskPlan): string {
	const head = `Task plan (${plan.kind}): ${plan.goal}${plan.abandoned ? ` — ABANDONED: ${plan.abandoned}` : ""}`;
	const lines = plan.items.map((item) => {
		const note = item.note ? ` — ${item.note}` : "";
		return `  [${item.id}] ${STATUS_MARK[item.status]} ${item.kind === "step" ? "" : `${item.kind}: `}${item.text}${note}`;
	});
	return [head, ...lines].join("\n");
}

/** One compact line for the end of the user-facing reply. */
export function formatPlanStatus(plan: TaskPlan): string {
	if (plan.abandoned) return `Plan abandoned: ${plan.abandoned}`;
	const items = plan.items.map((item) => {
		const text = firstLine(item.text, 40);
		return item.status === "deferred"
			? `${STATUS_MARK.deferred} ${text} (${firstLine(item.note ?? "", 60)})`
			: `${STATUS_MARK[item.status]} ${text}`;
	});
	const review = plan.review
		? "skipped" in plan.review
			? `⚠ not reviewed (${plan.review.skipped})`
			: plan.review.verdict === "ok"
				? `reviewed by ${plan.review.model}: no gaps`
				: `reviewed by ${plan.review.model}: ${plan.review.mustFix} gap(s) sent back`
		: undefined;
	return [...items, ...(review ? [review] : [])].join(" · ");
}

/**
 * Evidence for closing a verify item: a check command (not a read/grep) passed after the last file
 * change in `runMessages`. Returns the problem, or undefined when the evidence is there.
 */
export function verifyEvidenceProblem(runMessages: AgentMessage[]): string | undefined {
	const runs = toolRuns(runMessages);
	const { lastCheck } = checkAfterLastChange(runs);
	if (!lastCheck) {
		return "no check command has run since the last file change (reading, grepping or listing does not count). Run the command that proves the change works, then close this item.";
	}
	if (lastCheck.isError) {
		return `the last check since the last file change failed: ${firstLine(lastCheck.output)}. Fix it and rerun before closing this item.`;
	}
	return undefined;
}

/** Output of the passing check after the last change, for the reviewer. */
export function verifyOutput(runMessages: AgentMessage[], maxChars = 4000): string | undefined {
	const { lastCheck } = checkAfterLastChange(toolRuns(runMessages));
	if (!lastCheck || lastCheck.isError) return undefined;
	return `$ ${lastCheck.command}\n${lastCheck.output.slice(-maxChars)}`;
}

export interface PlanActionResult {
	plan?: TaskPlan;
	error?: string;
}

/**
 * Applies one `task_plan` tool call. `runMessages` is the current run so far (verify evidence);
 * `request` is the user message that started it (recorded on create).
 */
export function applyPlanAction(
	current: TaskPlan | undefined,
	input: TaskPlanInput,
	context: { runMessages: AgentMessage[]; request: string; now?: Date },
): PlanActionResult {
	switch (input.action) {
		case "show":
			return current ? { plan: current } : { error: "No task plan." };

		case "create": {
			if (current && isPlanOpen(current)) {
				return {
					error: `A plan is already open. Add to it, close its items, or abandon it first.\n${formatPlan(current)}`,
				};
			}
			const goal = input.goal?.trim();
			const verify = input.verify?.trim();
			if (!goal) return { error: "create needs `goal`." };
			if (!verify) return { error: "create needs `verify`: the check that will prove the change works." };
			const kind = input.kind ?? "change";
			const steps = (input.items ?? []).map((text) => text.trim()).filter(Boolean);
			const drafts = [
				...(kind === "fix" ? FIX_ITEMS : []),
				...steps.map((text) => ({ kind: "step" as const, text })),
				{ kind: "verify" as const, text: verify },
			];
			if (drafts.length > MAX_PLAN_ITEMS) {
				return { error: `At most ${MAX_PLAN_ITEMS} items; group smaller steps together.` };
			}
			return {
				plan: {
					kind,
					goal,
					request: context.request,
					items: drafts.map((d, i) => ({ id: i + 1, kind: d.kind, text: d.text, status: "open" })),
					createdAt: (context.now ?? new Date()).toISOString(),
				},
			};
		}

		case "add": {
			if (!current || current.abandoned) return { error: "No plan to add to; create one." };
			const steps = (input.items ?? []).map((text) => text.trim()).filter(Boolean);
			if (steps.length === 0) return { error: "add needs `items`." };
			// If no verify item is still open, these steps would ship unverified (issue #387); a new
			// verify item is required and appended after them. Otherwise the existing open verify item
			// already covers what's added, so a supplied `verify` is ignored (documented on the tool).
			const hasOpenVerify = current.items.some((item) => item.kind === "verify" && item.status === "open");
			const verify = input.verify?.trim();
			if (!hasOpenVerify && !verify) {
				return {
					error: "These steps come after verification closed; pass `verify`: the check that will prove them.",
				};
			}
			const extra = hasOpenVerify ? 0 : 1;
			if (current.items.length + steps.length + extra > MAX_PLAN_ITEMS) {
				return { error: `At most ${MAX_PLAN_ITEMS} items; group smaller steps together.` };
			}
			const nextId = Math.max(0, ...current.items.map((item) => item.id)) + 1;
			const added: PlanItem[] = steps.map((text, i) => ({
				id: nextId + i,
				kind: "step" as const,
				text,
				status: "open" as const,
			}));
			if (!hasOpenVerify) {
				added.push({ id: nextId + steps.length, kind: "verify", text: verify as string, status: "open" });
			}
			return { plan: { ...current, items: [...current.items, ...added] } };
		}

		case "update": {
			if (!current || current.abandoned) return { error: "No plan to update; create one." };
			const item = current.items.find((i) => i.id === input.id);
			if (!item) return { error: `No item ${input.id}.\n${formatPlan(current)}` };
			const status = input.status ?? item.status;
			// Issue #388: a note written for a closed status (a deferral reason) is stale once the status
			// changes; a note written while open (e.g. fix analysis) carries into the close.
			const carried = status === item.status || item.status === "open" ? item.note : undefined;
			const note = input.note?.trim() || carried;
			if (status === "deferred" && !input.note?.trim()) {
				return { error: "Deferring needs a `note` with the reason." };
			}
			const closing = status !== "open";
			if (closing && (item.kind === "root-cause" || item.kind === "siblings" || item.kind === "fix-scope")) {
				if ((note ?? "").length < MIN_FIX_NOTE_CHARS) {
					return { error: `Item ${item.id} (${item.kind}) closes with its content in \`note\`, not a tick.` };
				}
			}
			if (closing && item.kind === "verify") {
				// Deferral still needs the closest local check to have passed (e.g. a dry run before a real publish).
				const problem = verifyEvidenceProblem(context.runMessages);
				if (problem) return { error: `Cannot close verify item ${item.id}: ${problem}` };
			}
			const items = current.items.map((i) => (i.id === item.id ? { ...i, status, note } : i));
			return { plan: { ...current, items } };
		}

		case "abandon": {
			if (!current || current.abandoned) return { error: "No plan to abandon." };
			const reason = input.reason?.trim();
			if (!reason) return { error: "abandon needs a `reason`." };
			return { plan: { ...current, abandoned: reason } };
		}
	}
}

/** True when this run did anything the plan governs: changed files or touched the plan. */
export function runTouchedPlan(runMessages: AgentMessage[]): boolean {
	return toolRuns(runMessages).some((run) => run.name === "task_plan" || runChangesFiles(run));
}
