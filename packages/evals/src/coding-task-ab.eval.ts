import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { CodingJudge, codingHarness, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { easyTasks } from "./coding-tasks-easy.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does offering the `task` sub-agent tool cost anything? The model decides whether to delegate; the tool only exists in
// the candidate arm. Ships on by default only if this shows no drop in correctness (goal item 6). Same tasks, model and
// thinking level. Comparative, so judgeThreshold is null and wrong answers show up as pass-rate difference in the report.
const REPETITIONS = Number(process.env.TASK_AB_REPETITIONS ?? "3");

for (const task of [...easyTasks, ...hardTasks]) {
	const table = evalHarnessTable(`task tool A/B ${task.id}`, {
		baseline: codingHarness(`task-off-${task.id}`, task, false, { taskTool: { enabled: false } }),
		candidate: codingHarness(`task-on-${task.id}`, task, false, { taskTool: { enabled: true } }),
		repetitions: REPETITIONS,
	});
	describe.for(table)(`${task.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(`Task tool A/B ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
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
