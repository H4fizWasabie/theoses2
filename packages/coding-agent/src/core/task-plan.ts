/**
 * Task Plan (issue #382): the list of everything a change involves, kept by the model through the
 * `task_plan` tool. The model decides whether to use it; the harness never requires a plan and
 * never holds a run open for one. When the model does plan, the plan is held to its own rules.
 *
 * Why: on 2026-09-26 a workspace redesign touched two stages. The model rewrote the first, a failed
 * edit silently dropped the second, and "done" was judged from memory instead of a list. A plan the
 * harness can read turns "half done" into a state it can see:
 *   - a `fix` plan starts with root cause / siblings / fix scope, so a fix looks past the symptom;
 *   - each verify item declares a runtime command and captures its passing, post-change result;
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
import { firstLine, type ToolRun } from "./tool-runs.ts";
import { type RunEvidence, readRunEvidence } from "./verification-evidence.ts";

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
	/** Exact command declared before verification; absent on historical session entries. */
	verifyCommand?: string;
	/** Last tool result at declaration: an earlier check cannot satisfy a new/rebound obligation. */
	verifyAfter?: string;
	/** Recorded successful execution, never supplied by the model. */
	evidence?: VerificationEvidence;
}

export interface VerificationEvidence {
	toolCallId: string;
	command: string;
	output: string;
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
	verify_command?: string;
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
		const command = item.verifyCommand
			? `\n    $ ${item.verifyCommand}${item.evidence ? ` [evidence: ${item.evidence.toolCallId}]` : ""}`
			: "";
		return `  [${item.id}] ${STATUS_MARK[item.status]} ${item.kind === "step" ? "" : `${item.kind}: `}${item.text}${note}${command}`;
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

function declaredCommandProblem(command: string | undefined, runEvidence: RunEvidence): string | undefined {
	if (!command?.trim()) return "declare `verify_command`: the exact runtime command for this item.";
	if (!runEvidence.isRuntimeCheck(command))
		return "`verify_command` must execute runtime behavior (run the tests or the changed code), not just syntax/lint/build, help/list, observation or source/unknown writes. If no existing command qualifies, put the check in a script and declare that (for example `bash scripts/verify.sh`).";
	return undefined;
}

/** Only this item's declared runtime command, after the last source/unknown change and its declaration, can close it. */
function verificationResult(
	runEvidence: RunEvidence,
	command: string | undefined,
	after?: string,
): { run?: ToolRun; problem?: string } {
	const declaration = declaredCommandProblem(command, runEvidence);
	if (declaration) return { problem: declaration };
	const lastCheck = runEvidence.check({ command, after });
	if (!lastCheck)
		return {
			problem: `no check command matching \`verify_command\` has run since the last file change. Run exactly \`${command}\`, then close this item.`,
		};
	if (lastCheck.isError)
		return {
			problem: `the matching runtime check failed: ${firstLine(lastCheck.output)}. Fix it and rerun before closing this item.`,
		};
	return { run: lastCheck };
}

function boundedOutput(output: string, maxChars = 4000): string {
	if (output.length <= maxChars) return output;
	const marker = "\n[verification output truncated; inspect the full tool result/artifact]\n";
	const half = Math.floor((maxChars - marker.length) / 2);
	return `${output.slice(0, half)}${marker}${output.slice(-half)}`;
}

function evidenceOf(run: ToolRun): VerificationEvidence {
	return { toolCallId: run.id, command: run.command as string, output: boundedOutput(run.output) };
}

/**
 * Keeps the final verify item's evidence current when the run changed files, by the same rule that closes it: a
 * matching check that passed after the last change becomes its evidence; with none, the item reopens. Earlier verify
 * items keep their historical evidence. Returns `plan` itself when nothing changes.
 */
export function refreshFinalVerify(plan: TaskPlan, runEvidence: RunEvidence): TaskPlan {
	const final = plan.items.filter((item) => item.kind === "verify").at(-1);
	if (plan.abandoned || !final || final.status === "open" || !runEvidence.changed) return plan;
	const { run } = verificationResult(runEvidence, final.verifyCommand, final.verifyAfter);
	if (run && run.id === final.evidence?.toolCallId) return plan;
	const refreshed: PlanItem = run
		? { ...final, evidence: evidenceOf(run) }
		: { ...final, status: "open", evidence: undefined };
	return { ...plan, items: plan.items.map((item) => (item.id === final.id ? refreshed : item)) };
}

/** Each closed item's captured result, including evidence from earlier turns, for the reviewer. */
export function verifyOutput(plan: TaskPlan, maxChars = 4000): string | undefined {
	const parts = plan.items
		.filter((item) => item.kind === "verify" && item.status !== "open" && item.evidence)
		.map(
			(item) =>
				`[${item.id}] ${item.text}\nTool call: ${item.evidence!.toolCallId}\n$ ${item.evidence!.command}\n${boundedOutput(item.evidence!.output, maxChars)}`,
		);
	return parts.length ? parts.join("\n\n") : undefined;
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
	context: { runMessages: AgentMessage[]; request: string; now?: Date; cwd?: string },
): PlanActionResult {
	const runEvidence = readRunEvidence(context.runMessages, context.cwd ?? process.cwd());
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
			const verifyCommand = input.verify_command?.trim();
			const declaration = declaredCommandProblem(verifyCommand, runEvidence);
			if (declaration) return { error: `create needs valid verification: ${declaration}` };
			const kind = input.kind ?? "change";
			const steps = (input.items ?? []).map((text) => text.trim()).filter(Boolean);
			const drafts = [
				...(kind === "fix" ? FIX_ITEMS : []),
				...steps.map((text) => ({ kind: "step" as const, text })),
				{
					kind: "verify" as const,
					text: verify,
					verifyCommand,
					verifyAfter: runEvidence.lastRunId,
				},
			];
			if (drafts.length > MAX_PLAN_ITEMS) {
				return { error: `At most ${MAX_PLAN_ITEMS} items; group smaller steps together.` };
			}
			return {
				plan: {
					kind,
					goal,
					request: context.request,
					items: drafts.map((d, i) => ({ id: i + 1, ...d, status: "open" })),
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
			const verifyCommand = input.verify_command?.trim();
			if (!hasOpenVerify) {
				const declaration = declaredCommandProblem(verifyCommand, runEvidence);
				if (declaration) return { error: `add needs valid verification: ${declaration}` };
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
				added.push({
					id: nextId + steps.length,
					kind: "verify",
					text: verify as string,
					verifyCommand,
					verifyAfter: runEvidence.lastRunId,
					status: "open",
				});
			}
			return { plan: { ...current, items: [...current.items, ...added] } };
		}

		case "update": {
			if (!current || current.abandoned) return { error: "No plan to update; create one." };
			const item = current.items.find((i) => i.id === input.id);
			if (!item) return { error: `No item ${input.id}.\n${formatPlan(current)}` };
			const status = input.status ?? item.status;
			let verifyCommand = item.verifyCommand;
			let verifyAfter =
				item.kind === "verify" && status === "open" && item.status !== "open"
					? runEvidence.lastRunId
					: item.verifyAfter;
			if (input.verify_command !== undefined) {
				if (item.kind !== "verify" || status !== "open")
					return { error: "Change `verify_command` only while the verify item is open; rerun before closing." };
				verifyCommand = input.verify_command.trim();
				verifyAfter = runEvidence.lastRunId;
				const declaration = declaredCommandProblem(verifyCommand, runEvidence);
				if (declaration) return { error: declaration };
			}
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
			let evidence: VerificationEvidence | undefined;
			if (closing && item.kind === "verify") {
				// A deferral captures the declared local runtime check, not an unapproved live publish.
				const result = verificationResult(runEvidence, verifyCommand, verifyAfter);
				if (result.problem || !result.run)
					return { error: `Cannot close verify item ${item.id}: ${result.problem}` };
				evidence = evidenceOf(result.run);
			}
			const items = current.items.map((i) => {
				if (i.id !== item.id) return i;
				return item.kind === "verify"
					? { ...i, status, note, verifyCommand, verifyAfter, evidence }
					: { ...i, status, note };
			});
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
