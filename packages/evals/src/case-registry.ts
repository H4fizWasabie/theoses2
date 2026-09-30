// One row per coding eval case: what capability it covers and whether it is pinned into every tier. The task
// definitions stay in coding-tasks-*.ts and replay-tasks.ts; test/case-registry.test.ts fails when the two disagree,
// so a new task cannot be silently left out of every tier.

export type Suite = "coding" | "coding-hard" | "coding-recovery" | "coding-replay";

export type Category =
	| "bugfix" // a failing test, one place to fix
	| "root-cause" // the cause is not where the symptom is: siblings, misleading errors, dependents
	| "investigation" // find the cause in a large or under-specified codebase, then fix
	| "refactor" // one change applied consistently across files
	| "implement" // new behavior from tests or a spec
	| "recovery" // the first edit is rejected; the agent must read the error and try again
	| "replay"; // a real bug from this repository's history

export type EvalCase = {
	suite: Suite;
	id: string;
	category: Category;
	/** In every tier. Keep these cheap and reliable: a failing core case should mean something broke. */
	core?: true;
	/** ISO date. Only for cases added after the registry was created; a case added in the last 14 days runs in `rotate`. */
	added?: string;
	/** Too slow for `smoke`'s rotation; `rotate` and `full` still run it, and `smoke` still re-runs it after a failure. */
	slow?: true;
	/** "regression": promoted from a real failure. */
	origin?: "regression";
	/** Why the case no longer runs. Retired cases stay in the fixture tests but leave every tier. */
	retired?: string;
	/** ISO date of the last human review. Cases unreviewed for 180 days are listed by `plan-evals`. */
	reviewed?: string;
};

export const REGISTRY_CREATED = "2026-09-30";

export const SUITE_FILES: Record<Suite, string> = {
	coding: "src/coding.eval.ts",
	"coding-hard": "src/coding-hard.eval.ts",
	"coding-recovery": "src/coding-recovery.eval.ts",
	"coding-replay": "src/coding-replay.eval.ts",
};

/** Evals that are not coding cases: always run in `smoke`/`rotate`, or only in `full`. */
export const EXTRA_FILES = { smoke: "src/smoke.eval.ts", extensions: "src/extensions.eval.ts" } as const;

export const evalCases: EvalCase[] = [
	{ suite: "coding", id: "fix-off-by-one", category: "bugfix", core: true },
	{ suite: "coding", id: "fix-from-stack-trace", category: "bugfix" },
	{ suite: "coding", id: "rename-across-files", category: "refactor", core: true },
	{ suite: "coding", id: "implement-from-tests", category: "implement", core: true },
	{ suite: "coding", id: "add-option-keep-behavior", category: "implement" },

	// sibling-sort-bug is the core root-cause case because the default config (edit sibling hint on) passes it; the
	// other three fail with the production model and mostly separate models from each other.
	{ suite: "coding-hard", id: "sibling-sort-bug", category: "root-cause", core: true },
	{ suite: "coding-hard", id: "sibling-sort-bug-unstated", category: "root-cause" },
	{ suite: "coding-hard", id: "misleading-error-shallow-merge", category: "root-cause" },
	{ suite: "coding-hard", id: "dependents-return-shape", category: "root-cause" },
	{ suite: "coding-hard", id: "navigate-many-files", category: "investigation", core: true },
	{ suite: "coding-hard", id: "bug-report-no-tests", category: "investigation" },
	{ suite: "coding-hard", id: "circular-import", category: "bugfix" },
	{ suite: "coding-hard", id: "async-dedupe-race", category: "bugfix" },
	{ suite: "coding-hard", id: "quadratic-performance", category: "bugfix" },
	{ suite: "coding-hard", id: "shared-mutable-state", category: "bugfix" },
	{ suite: "coding-hard", id: "rename-with-lookalikes", category: "refactor" },
	{ suite: "coding-hard", id: "change-signature-all-callers", category: "refactor" },
	{ suite: "coding-hard", id: "implement-from-spec", category: "implement" },

	{ suite: "coding-recovery", id: "edit-duplicate-line", category: "recovery", core: true },
	{ suite: "coding-recovery", id: "edit-quoted-with-spaces", category: "recovery" },
	{ suite: "coding-recovery", id: "edit-stale-description", category: "recovery" },

	// Replay is slow (repository archive plus a spawned vitest to grade): never core, and `smoke` does not rotate it in.
	// `rotate` always samples at least one.
	{
		suite: "coding-replay",
		id: "retry-generic-finish-reason-error",
		category: "replay",
		slow: true,
		origin: "regression",
	},
	{ suite: "coding-replay", id: "retry-invalid-request-error", category: "replay", slow: true, origin: "regression" },
	{ suite: "coding-replay", id: "auto-resume-timer-leak", category: "replay", slow: true, origin: "regression" },
	{ suite: "coding-replay", id: "promotion-current-turn", category: "replay", slow: true, origin: "regression" },
];

export function caseId(suite: Suite, id: string): string {
	return `${suite}/${id}`;
}

/** The harness name the coding suites give a case (`coding-suite.ts`, `coding-replay.eval.ts`). */
export function harnessName(suite: Suite, id: string): string {
	return `${suite}-${id}`;
}

/** The case a run record belongs to, or undefined for a harness outside the registry (A/B arms, batching, ...). */
export function caseOfHarness(harness: string, cases: readonly EvalCase[] = evalCases): EvalCase | undefined {
	return cases.find((candidate) => harnessName(candidate.suite, candidate.id) === harness);
}
