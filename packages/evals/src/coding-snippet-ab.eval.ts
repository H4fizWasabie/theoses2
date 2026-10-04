import { describeCodingAb } from "./coding-suite.ts";
import { hardTasks } from "./coding-tasks-hard.ts";
import { recoveryTasks } from "./coding-tasks-recovery.ts";
import { replayTasks } from "./replay-tasks.ts";

// Does putting the changed lines in the edit result cut the read-backs that follow an edit, without costing correctness?
// Same tasks, model and thinking level; only the `editSnippet` setting differs. Comparative, so judgeThreshold is null.
// Compare tool calls and tokens per arm (`usage.toolCalls` in runs.jsonl) as well as the pass rate.
describeCodingAb({
	arm: "snippet",
	label: "edit snippet",
	repetitionsEnv: "SNIPPET_AB_REPETITIONS",
	tasks: [...hardTasks, ...recoveryTasks],
	replays: replayTasks,
	baseline: { settings: { editSnippet: false } },
	candidate: { settings: { editSnippet: true } },
});
