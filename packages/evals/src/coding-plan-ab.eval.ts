import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { CodingJudge, codingHarness, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does the Task Plan help on the tasks GLM gets wrong? The hard set's failures are all "fixed the reported symptom, missed
// the siblings" (sibling-sort-bug 0/3, misleading-error-shallow-merge 0/3), which is what the plan's `fix` kind
// (root cause, siblings, fix scope) is meant to catch. Same tasks, model and thinking level; only the plan differs.
// Comparative, so judgeThreshold is null and the wrong answers show up as pass-rate lift in the report.
const REPETITIONS = Number(process.env.PLAN_AB_REPETITIONS ?? "3");

for (const task of hardTasks) {
	const table = evalHarnessTable(`plan A/B ${task.id}`, {
		baseline: codingHarness(`plan-off-${task.id}`, task, false),
		candidate: codingHarness(`plan-on-${task.id}`, task, true),
		repetitions: REPETITIONS,
	});
	describe.for(table)(`${task.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(`Plan A/B ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
			it(
				"solves the task",
				async ({ run }) => {
					await run(task.prompt);
				},
				TASK_TIMEOUT_MS,
			);
		});
	});
}
