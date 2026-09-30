import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { CodingJudge, codingHarness, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { easyTasks } from "./coding-tasks-easy.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does a short working-discipline paragraph in the system prompt help? Adopted only if this shows a win (goal item 7).
// Same tasks, model and thinking level; only the appended paragraph differs. Comparative, so judgeThreshold is null.
export const DISCIPLINE = `

Working discipline:
- Read a file before you edit it, and read the code that calls or is called by what you change.
- Make the smallest change that fully fixes the problem. Do not refactor, rename or reformat what the task does not need.
- When you fix a bug, look for the same mistake in sibling code before you finish.
- Verify before you say you are done: run the relevant tests or command and look at the result.`;

const REPETITIONS = Number(process.env.PROMPT_AB_REPETITIONS ?? "3");

for (const task of [...easyTasks, ...hardTasks]) {
	const table = evalHarnessTable(`prompt A/B ${task.id}`, {
		baseline: codingHarness(`prompt-off-${task.id}`, task),
		candidate: codingHarness(`prompt-on-${task.id}`, task, false, {}, (prompt) => prompt + DISCIPLINE),
		repetitions: REPETITIONS,
	});
	describe.for(table)(`${task.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(`Prompt A/B ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
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
