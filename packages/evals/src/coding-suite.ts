import type { ThinkingLevel } from "theoses-agent-core";
import type { SettingsManager } from "theoses-coding-agent";
import { createJudge, describeEval } from "vitest-evals";
import type { Suite } from "./case-registry.ts";
import { type CodingOutput, type CodingTask, gradeWorkspace } from "./coding-grader.ts";
import { selectedTasks } from "./selection.ts";
import { createTheosesCodingAgentHarness, type TheosesCodingAgentInput } from "./theoses-harness.ts";

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

/**
 * The harness for one coding task. The deployed agent runs the task plan off (the library default is on, which adds
 * task-plan and independent plan-review round trips that pushed a trivial rename past the timeout), so `taskPlan`
 * defaults to false; the plan A/B turns it on for the candidate.
 */
export function codingHarness(
	name: string,
	task: CodingTask,
	taskPlan = false,
	/** Extra in-memory settings, e.g. `taskTool` for the sub-agent A/B. */
	settings: Parameters<typeof SettingsManager.inMemory>[0] = {},
	/** Rewrites the system prompt, for the prompt A/B. */
	transformSystemPrompt?: (defaultPrompt: string) => string,
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
