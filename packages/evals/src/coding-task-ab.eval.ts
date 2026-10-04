import { describeCodingAb } from "./coding-suite.ts";

// Does offering the `task` sub-agent tool cost anything? The model decides whether to delegate; the tool only exists in
// the candidate arm. Ships on by default only if this shows no drop in correctness (goal item 6). Same tasks, model and
// thinking level. Comparative, so judgeThreshold is null and wrong answers show up as pass-rate difference in the report.
describeCodingAb({
	arm: "task",
	label: "task tool",
	repetitionsEnv: "TASK_AB_REPETITIONS",
	baseline: { settings: { taskTool: { enabled: false } } },
	candidate: { settings: { taskTool: { enabled: true } } },
});
