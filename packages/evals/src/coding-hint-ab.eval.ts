import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { CodingJudge, codingHarness, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { easyTasks } from "./coding-tasks-easy.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does saying, after an edit, where else the replaced text appears help the agent finish a fix that has siblings
// (`sibling-sort-bug-unstated` is the target) without costing correctness or tokens elsewhere? Same tasks, model and
// thinking level; only the `editSiblingHint` setting differs. Comparative, so judgeThreshold is null.
const REPETITIONS = Number(process.env.HINT_AB_REPETITIONS ?? "3");

for (const task of [...easyTasks, ...hardTasks]) {
	const table = evalHarnessTable(`edit hint A/B ${task.id}`, {
		baseline: codingHarness(`hint-off-${task.id}`, task, false, { editSiblingHint: false }),
		candidate: codingHarness(`hint-on-${task.id}`, task, false, { editSiblingHint: true }),
		repetitions: REPETITIONS,
	});
	describe.for(table)(`${task.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(`Edit hint A/B ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
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
