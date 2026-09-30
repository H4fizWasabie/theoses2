import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { CodingJudge, codingHarness, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { recoveryTasks } from "./coding-tasks-recovery.ts";
import { gradeReplay, hasCommit, seedReplayWorkspace } from "./replay-grader.ts";
import { replayTasks } from "./replay-tasks.ts";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does putting the changed lines in the edit result cut the read-backs that follow an edit, without costing correctness?
// Same tasks, model and thinking level; only the `editSnippet` setting differs. Comparative, so judgeThreshold is null.
// Compare tool calls and tokens per arm (`usage.toolCalls` in runs.jsonl) as well as the pass rate.
const REPETITIONS = Number(process.env.SNIPPET_AB_REPETITIONS ?? "3");

function replayHarness(name: string, task: (typeof replayTasks)[number], editSnippet: boolean) {
	return createTheosesCodingAgentHarness({
		name,
		seed: (cwd) => seedReplayWorkspace(cwd, task),
		thinkingLevel: (process.env.EVAL_THINKING_LEVEL as "max" | undefined) ?? "max",
		settings: { taskPlan: { enabled: false }, editSnippet },
		output: ({ session }) => gradeReplay(session.sessionManager.getCwd(), task),
	});
}

const arms = [
	...[...hardTasks, ...recoveryTasks].map((task) => ({
		id: task.id,
		prompt: task.prompt,
		baseline: codingHarness(`snippet-off-${task.id}`, task, false, { editSnippet: false }),
		candidate: codingHarness(`snippet-on-${task.id}`, task, false, { editSnippet: true }),
	})),
	...replayTasks
		.filter((task) => hasCommit(task.fixCommit))
		.map((task) => ({
			id: `replay-${task.id}`,
			prompt: task.prompt,
			baseline: replayHarness(`snippet-off-replay-${task.id}`, task, false),
			candidate: replayHarness(`snippet-on-replay-${task.id}`, task, true),
		})),
];

for (const arm of arms) {
	const table = evalHarnessTable(`edit snippet A/B ${arm.id}`, {
		baseline: arm.baseline,
		candidate: arm.candidate,
		repetitions: REPETITIONS,
	});
	describe.for(table)(`${arm.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(`Edit snippet A/B ${arm.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
			it(
				"solves the task",
				async ({ run }) => {
					await run(arm.prompt);
				},
				TASK_TIMEOUT_MS,
			);
		});
	});
}
