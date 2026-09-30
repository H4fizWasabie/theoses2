import { describeCodingTasks } from "./coding-suite.ts";
import { hardTasks } from "./coding-tasks-hard.ts";

// The hard tasks the production model fails every time, for running against another model (workflow input `model`) to
// tell a model limit from a task or harness problem. Repeat with the workflow's `passes` input.
const DIAGNOSED = new Set(["sibling-sort-bug", "sibling-sort-bug-unstated", "misleading-error-shallow-merge"]);

describeCodingTasks(
	"diagnose",
	hardTasks.filter((task) => DIAGNOSED.has(task.id)),
);
