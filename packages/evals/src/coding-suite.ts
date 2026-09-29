import { createJudge, describeEval } from "vitest-evals";
import { type CodingOutput, type CodingTask, gradeWorkspace } from "./coding-grader.ts";
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

/** One eval per task. `suite` prefixes harness names so run reports from different sets stay apart. */
export function describeCodingTasks(suite: string, tasks: CodingTask[]): void {
	for (const task of tasks) {
		const harness = createTheosesCodingAgentHarness({
			name: `${suite}-${task.id}`,
			files: task.files,
			// Production runs at "max" (settings.json defaultThinkingLevel); baseline the same.
			thinkingLevel: "max",
			// The deployed agent sets taskPlan.enabled=false; the library default is true, which adds
			// task-plan and independent plan-review round trips that pushed a trivial rename past the timeout.
			settings: { taskPlan: { enabled: false } },
			output: ({ session }): CodingOutput => gradeWorkspace(session.sessionManager.getCwd(), task),
		});

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
