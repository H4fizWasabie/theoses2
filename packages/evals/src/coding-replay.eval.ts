import { describeEval } from "vitest-evals";
import { CodingJudge, TASK_TIMEOUT_MS } from "./coding-suite.ts";
import { gradeReplay, hasCommit, seedReplayWorkspace } from "./replay-grader.ts";
import { replayTasks } from "./replay-tasks.ts";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

// Real fixes from this repo's history, graded by the regression test each fix added (see replay-grader.ts). Skipped
// where the fix commits are not available (a shallow clone), so a partial checkout cannot report a false failure.
for (const task of replayTasks.filter((candidate) => hasCommit(candidate.fixCommit))) {
	const harness = createTheosesCodingAgentHarness({
		name: `coding-replay-${task.id}`,
		seed: (cwd) => seedReplayWorkspace(cwd, task),
		thinkingLevel: "max",
		settings: { taskPlan: { enabled: false } },
		output: ({ session }) => gradeReplay(session.sessionManager.getCwd(), task),
	});

	describeEval(`Theoses coding-replay: ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: 1 }, (it) => {
		it(
			"fixes the bug",
			async ({ run }) => {
				await run(task.prompt);
			},
			TASK_TIMEOUT_MS,
		);
	});
}
