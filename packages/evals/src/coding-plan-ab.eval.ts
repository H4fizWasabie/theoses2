import { describeCodingAb } from "./coding-suite.ts";
import { hardTasks } from "./coding-tasks-hard.ts";

// Does the Task Plan help on the tasks GLM gets wrong? The hard set's failures are all "fixed the reported symptom, missed
// the siblings" (sibling-sort-bug 0/3, misleading-error-shallow-merge 0/3), which is what the plan's `fix` kind
// (root cause, siblings, fix scope) is meant to catch. Same tasks, model and thinking level; only the plan differs.
// Comparative, so judgeThreshold is null and the wrong answers show up as pass-rate lift in the report.
describeCodingAb({
	arm: "plan",
	label: "plan",
	repetitionsEnv: "PLAN_AB_REPETITIONS",
	tasks: hardTasks,
	baseline: { taskPlan: false },
	candidate: { taskPlan: true },
});
