/**
 * Task-plan reviewer (issue #382): once every plan item is closed on a fix or multi-item change, a
 * sub-agent with fresh context and a different model family from the worker checks whether the
 * change is complete. It sees the user's request, the plan, the diff and the verify output, and can
 * read the codebase to find what the diff is missing (a sibling file that relies on the same
 * assumption, a check that never ran the changed code). The worker shares its own blind spots; a
 * fresh reader does not.
 *
 * Only must-fix findings go back to the worker. Every review is logged to review-log.jsonl so its
 * hit rate can be checked before it earns a permanent place (self-diagnostic's completion check was
 * dropped after 45 flags and no real hits).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import type { AssistantMessage } from "theoses-ai";
import { getAgentDir } from "../config.ts";
import { createBudgetedAgent, lastAssistantText } from "./background-agent.ts";
import { resolveBackgroundModel } from "./background-models.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProviderHooks } from "./provider-hooks.ts";
import { formatPlan, type TaskPlan } from "./task-plan.ts";
import { createFindToolDefinition } from "./tools/find.ts";
import { createGrepToolDefinition } from "./tools/grep.ts";
import { createLsToolDefinition } from "./tools/ls.ts";
import { createReadToolDefinition } from "./tools/read.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";

export const PLAN_REVIEW_CUSTOM_TYPE = "plan-review";
/** Exported for tests. */
export const MAX_TURNS = 8;
const MAX_INPUT_TOKENS = 200_000;
const MAX_MUST_FIX = 5;
export const MAX_DIFF_CHARS = 40_000;

export interface ReviewFinding {
	severity: "must-fix" | "nit";
	file?: string;
	issue: string;
	evidence?: string;
}

export interface ReviewOutcome {
	model: string;
	verdict: "ok" | "gaps";
	/** Must-fix findings only, capped at MAX_MUST_FIX. */
	mustFix: ReviewFinding[];
	nits: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

export interface ReviewInput {
	plan: TaskPlan;
	diff: string;
	verifyOutput: string | undefined;
	/** Directories outside cwd that the change touched. */
	locations: string[];
	cwd: string;
	modelRuntime: ModelRuntime;
	providerHooks?: ProviderHooks;
	signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You review a finished change for completeness. Another agent (the worker) made it and says it is done. Your job is to find what is missing, not to restyle what is there.

You get the user's request, the worker's task plan (with its notes), the diff of every file it changed, and the output of its verification command. You can read the codebase with read, grep, find and ls.

Look for:
1. Parts of the request the diff does not cover.
2. Other places that rely on the same assumption as the changed code and were left unchanged (callers, sibling scripts, config, later pipeline stages). Search for them; the diff alone cannot show what is missing from it.
3. Verification that did not exercise the changed code (a dry run that exits before it, a syntax check presented as a test).
4. A fix that patches where the failure showed up instead of why it happened, or a plan of kind "change" that is really a fix.
5. A finding that is one instance of a pattern: a hard-coded list or allowlist, an enumerated special case, a check keyed on the names the author happened to think of. When you find one instance, name the pattern in the issue, search the code and the situations it must serve (other languages, tools, platforms, input formats) for the members it misses, and say how to fix the pattern itself, so the worker does not patch members one at a time.

Each finding needs concrete evidence: a file and line, or the command output that shows it. "must-fix" means the request is not met or something will break; everything else is "nit". If nothing is missing, say so.

Items under <accepted_deferrals> were left undone on purpose, with the reason given (for example, waiting for the user's approval before publishing). They are not findings, even when the request asks for them. Only report one if its reason is false, with evidence.

Your final message must be only this JSON, no prose:
{"verdict": "ok" | "gaps", "findings": [{"severity": "must-fix" | "nit", "file": "path", "issue": "what is missing or wrong", "evidence": "file:line or output"}]}`;

// 2026-09-28: both attempts of a review hit MAX_TURNS while still calling tools, so
// lastAssistantText never held a verdict and the whole read was thrown away (3 of 9 reviews
// since 09-27). Rather than let the turn budget run out mid-investigation, force exactly one
// more turn with no tools once the budget is hit, asking for a verdict from what it already saw.
const FORCE_VERDICT_PROMPT = `You are out of turns to investigate further. Stop here and give your verdict now, based only on what you have already read. Do not ask for more tools; none are available.

Reply with only the JSON described earlier, no prose.`;

/** Exported for tests. */
export function buildPrompt(
	plan: TaskPlan,
	diff: string,
	verifyOutput: string | undefined,
	locations: string[] = [],
): string {
	const cappedDiff =
		diff.length > MAX_DIFF_CHARS
			? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} chars; read the files for the rest]`
			: diff;
	// Issue #386: an inline "⏸ ... — reason" in the plan was not enough; the reviewer still flagged an
	// approval-gated publish as a must-fix because the request asked for it.
	const deferrals = plan.items
		.filter((item) => item.status === "deferred")
		.map((item) => `- [${item.id}] ${item.text} — reason: ${item.note ?? "(none)"}`);
	return [
		`<request>\n${plan.request || "(not recorded)"}\n</request>`,
		`<plan>\n${formatPlan(plan)}\n</plan>`,
		...(deferrals.length > 0 ? [`<accepted_deferrals>\n${deferrals.join("\n")}\n</accepted_deferrals>`] : []),
		// 2026-09-28: a change in /home/theoses/icm-workspaces/... was reviewed from the session cwd (the
		// Theoses release dir); the reviewer searched there, found nothing, and flagged the work as missing.
		...(locations.length > 0
			? [
					`<change_locations>\nThe change was made in these directories, outside the directory your tools start in. Pass them as absolute paths to read, grep, find and ls:\n${locations.map((l) => `- ${l}`).join("\n")}\n</change_locations>`,
				]
			: []),
		`<diff>\n${cappedDiff || "(no diff captured)"}\n</diff>`,
		`<verify_output>\n${verifyOutput ?? "(no passing check output captured)"}\n</verify_output>`,
	].join("\n\n");
}

/** Pulls the verdict JSON out of the reviewer's last message. Exported for tests. */
export function parseReview(text: string): { verdict: "ok" | "gaps"; findings: ReviewFinding[] } | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	const value = raw as { verdict?: unknown; findings?: unknown };
	if (value.verdict !== "ok" && value.verdict !== "gaps") return undefined;
	const findings = Array.isArray(value.findings)
		? value.findings.flatMap((f): ReviewFinding[] => {
				const item = f as Partial<ReviewFinding>;
				if (typeof item.issue !== "string" || !item.issue.trim()) return [];
				return [
					{
						severity: item.severity === "must-fix" ? "must-fix" : "nit",
						file: typeof item.file === "string" ? item.file : undefined,
						issue: item.issue,
						evidence: typeof item.evidence === "string" ? item.evidence : undefined,
					},
				];
			})
		: [];
	return { verdict: value.verdict, findings };
}

function runCost(messages: AgentMessage[]): number {
	let cost = 0;
	for (const m of messages) {
		if (m.role === "assistant") cost += (m as AssistantMessage).usage?.cost?.total ?? 0;
	}
	return cost;
}

/** Exported for tests. */
export async function reviewOnce(input: ReviewInput): Promise<ReviewOutcome> {
	const model = resolveBackgroundModel(input.modelRuntime, "reviewer");
	const handle = createBudgetedAgent({
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools: [
			createReadToolDefinition(input.cwd),
			createGrepToolDefinition(input.cwd),
			createFindToolDefinition(input.cwd),
			createLsToolDefinition(input.cwd),
		].map((definition) => wrapToolDefinition(definition)),
		modelRuntime: input.modelRuntime,
		maxTurns: MAX_TURNS,
		maxInputTokens: MAX_INPUT_TOKENS,
		signal: input.signal,
		providerHooks: input.providerHooks,
	});
	let stats = await handle.prompt(buildPrompt(input.plan, input.diff, input.verifyOutput, input.locations));
	let messages = handle.agent.state.messages;
	let parsed = parseReview(lastAssistantText(messages));
	if (!parsed && stats.stoppedByBudget) {
		// The budget ran out while the model was still investigating, so its last message carries no
		// verdict. One forced turn with tools removed - the same conversation, no new investigation -
		// asks it to commit to a verdict on what it already read instead of throwing that work away.
		handle.agent.state.tools = [];
		stats = await handle.prompt(FORCE_VERDICT_PROMPT);
		messages = handle.agent.state.messages;
		parsed = parseReview(lastAssistantText(messages));
	}
	if (!parsed) {
		throw new Error(stats.stoppedByBudget ? "budget ran out before a verdict" : "no parseable verdict");
	}
	const mustFix = parsed.findings.filter((f) => f.severity === "must-fix").slice(0, MAX_MUST_FIX);
	return {
		model: model.id,
		verdict: mustFix.length > 0 ? "gaps" : "ok",
		mustFix,
		nits: parsed.findings.length - mustFix.length,
		inputTokens: stats.inputTokens,
		outputTokens: stats.outputTokens,
		cost: runCost(messages),
	};
}

/** Runs the review, retrying once. Returns the skip reason instead of throwing. */
export async function reviewPlan(input: ReviewInput): Promise<ReviewOutcome | { skipped: string }> {
	let lastError = "";
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			return await reviewOnce(input);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			console.error(`[plan-review] attempt ${attempt} failed: ${lastError}`);
			if (input.signal?.aborted) break;
		}
	}
	return { skipped: lastError.slice(0, 120) || "review failed" };
}

/** The push-back text for must-fix findings. */
export function formatFindings(outcome: ReviewOutcome): string {
	const lines = outcome.mustFix.map((f, i) => {
		const where = f.file ? ` (${f.file})` : "";
		const evidence = f.evidence ? `\n   evidence: ${f.evidence}` : "";
		return `${i + 1}. ${f.issue}${where}${evidence}`;
	});
	return `An independent reviewer (${outcome.model}) checked your finished change and found gaps:\n${lines.join("\n")}\nFor each one: fix it (task_plan add an item, make the change, verify, close it), or, if you are sure it is wrong, say why in your final reply. A finding is often one instance of a wider pattern (a hard-coded list, an enumerated special case): fix the pattern, not only the reported case, and test it with inputs from outside the reported example's language, tool or format. There is no second review.`;
}

const REVIEW_LOG = join(getAgentDir(), "review-log.jsonl");

/** One line per review and per outcome, for the two-week hit-rate check. Never throws. */
export function logReview(entry: Record<string, unknown>): void {
	try {
		appendFileSync(REVIEW_LOG, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// Best-effort logging only.
	}
}
