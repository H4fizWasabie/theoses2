import type { ThinkingLevel } from "theoses-agent-core";
import type { SettingsManager } from "theoses-coding-agent";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { Suite } from "./case-registry.ts";
import { type CodingOutput, type CodingTask, gradeWorkspace } from "./coding-grader.ts";
import { easyTasks } from "./coding-tasks-easy.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { gradeReplay, hasCommit, type ReplayTask, seedReplayWorkspace } from "./replay-grader.ts";
import { selectedTasks } from "./selection.ts";
import { createTheosesCodingAgentHarness, type TheosesCodingAgentInput } from "./theoses-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Above the package-wide 120s so a slow agent run is scored on its result, not killed mid-fix.
const TASK_TIMEOUT_MS = 300_000;

const CodingJudge = createJudge<TheosesCodingAgentInput, CodingOutput>("CodingJudge", ({ output }) => {
	const failures: string[] = [];
	if (!output.testsPassed) failures.push("tests fail");
	if (!output.protectedIntact) failures.push("protected files modified");
	return {
		score: failures.length === 0 ? 1 : 0,
		metadata: { rationale: failures.length === 0 ? "Tests pass." : `${failures.join("; ")}\n${output.testOutput}` },
	};
});

/** What an A/B arm changes about a coding run. */
export type CodingHarnessOptions = {
	/** The deployed agent runs the task plan off, so this defaults to false; the plan A/B turns it on. */
	taskPlan?: boolean;
	/** Extra in-memory settings, e.g. `taskTool` for the sub-agent A/B. */
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** Rewrites the system prompt, for the prompt A/B. */
	transformSystemPrompt?: (defaultPrompt: string) => string;
};

/**
 * The harness for one coding task. The deployed agent runs the task plan off (the library default is on, which adds
 * task-plan and independent plan-review round trips that pushed a trivial rename past the timeout), so `taskPlan`
 * defaults to false; the plan A/B turns it on for the candidate.
 */
export function codingHarness(
	name: string,
	task: CodingTask,
	{ taskPlan = false, settings = {}, transformSystemPrompt }: CodingHarnessOptions = {},
) {
	return createTheosesCodingAgentHarness({
		name,
		files: task.files,
		// Production runs at "max" (settings.json defaultThinkingLevel); baseline the same. EVAL_THINKING_LEVEL overrides it,
		// to test whether the level changes behavior (workflow input `thinking`).
		thinkingLevel: (process.env.EVAL_THINKING_LEVEL as ThinkingLevel | undefined) ?? "max",
		// EVAL_SIBLING_HINT=off runs without the edit sibling hint, for diagnosis runs that must not have it.
		settings: {
			taskPlan: { enabled: taskPlan },
			...(process.env.EVAL_SIBLING_HINT === "off" ? { editSiblingHint: false } : {}),
			...settings,
		},
		transformSystemPrompt,
		output: ({ session }): CodingOutput => gradeWorkspace(session.sessionManager.getCwd(), task),
	});
}

/** The harness for one replay task, seeded from this repository's history and graded by the fix's regression test. */
function replayHarness(
	name: string,
	task: ReplayTask,
	{ taskPlan = false, settings = {}, transformSystemPrompt }: CodingHarnessOptions,
) {
	return createTheosesCodingAgentHarness({
		name,
		seed: (cwd) => seedReplayWorkspace(cwd, task),
		thinkingLevel: (process.env.EVAL_THINKING_LEVEL as ThinkingLevel | undefined) ?? "max",
		settings: { taskPlan: { enabled: taskPlan }, ...settings },
		transformSystemPrompt,
		output: ({ session }) => gradeReplay(session.sessionManager.getCwd(), task),
	});
}

export type CodingAbOptions = {
	/** Harness names are `<arm>-off-<task>` (baseline) and `<arm>-on-<task>` (candidate). */
	arm: string;
	/** Names the eval set `<label> A/B <task>` and titles the eval the same with a capital first letter. */
	label: string;
	/** The env var that sets the repetitions per arm; 3 when unset. */
	repetitionsEnv: string;
	/** Defaults to the easy and hard tasks. */
	tasks?: CodingTask[];
	/** Replay tasks run after `tasks` as `replay-<id>`, skipped where the fix commit is not available. */
	replays?: ReplayTask[];
	baseline: CodingHarnessOptions;
	candidate: CodingHarnessOptions;
};

/** One comparative eval per task, baseline against candidate. judgeThreshold is null: wrong answers show as pass rate. */
export function describeCodingAb({
	arm,
	label,
	repetitionsEnv,
	tasks = [...easyTasks, ...hardTasks],
	replays = [],
	baseline,
	candidate,
}: CodingAbOptions): void {
	const repetitions = Number(process.env[repetitionsEnv] ?? "3");
	const title = label[0].toUpperCase() + label.slice(1);
	const cases = [
		...tasks.map((task) => ({
			id: task.id,
			prompt: task.prompt,
			harness: (side: string, options: CodingHarnessOptions) =>
				codingHarness(`${arm}-${side}-${task.id}`, task, options),
		})),
		...replays
			.filter((task) => hasCommit(task.fixCommit))
			.map((task) => ({
				id: `replay-${task.id}`,
				prompt: task.prompt,
				harness: (side: string, options: CodingHarnessOptions) =>
					replayHarness(`${arm}-${side}-replay-${task.id}`, task, options),
			})),
	];
	for (const item of cases) {
		const table = evalHarnessTable(`${label} A/B ${item.id}`, {
			baseline: item.harness("off", baseline),
			candidate: item.harness("on", candidate),
			repetitions,
		});
		describe.for(table)(`${item.id} $name repetition $repetition`, ({ harness }) => {
			describeEval(`${title} A/B ${item.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
				it(
					"solves the task",
					async ({ run }) => {
						await run(item.prompt);
					},
					TASK_TIMEOUT_MS,
				);
			});
		});
	}
}

export { CodingJudge, TASK_TIMEOUT_MS };

/** One eval per task. `suite` prefixes harness names so run reports from different sets stay apart. */
export function describeCodingTasks(suite: Suite | "diagnose", tasks: CodingTask[]): void {
	// A tiered run (run-evals.mjs --tier) selects a subset through its manifest; `diagnose` is outside the tiers.
	for (const task of suite === "diagnose" ? tasks : selectedTasks(suite, tasks)) {
		const harness = codingHarness(`${suite}-${task.id}`, task);

		// Threshold 1: a wrong answer fails the test. With null a run that broke the tests still counted as passed,
		// and the first hard-set baseline was reported as 33/33 when 26 answers were right.
		describeEval(`Theoses ${suite}: ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: 1 }, (it) => {
			it(
				"solves the task",
				async ({ run }) => {
					await run(task.prompt);
				},
				TASK_TIMEOUT_MS,
			);
		});
	}
}
