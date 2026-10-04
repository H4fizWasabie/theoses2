import { describeCodingAb } from "./coding-suite.ts";

// Does saying, after an edit, where else the replaced text appears help the agent finish a fix that has siblings
// (`sibling-sort-bug-unstated` is the target) without costing correctness or tokens elsewhere? Same tasks, model and
// thinking level; only the `editSiblingHint` setting differs. Comparative, so judgeThreshold is null.
describeCodingAb({
	arm: "hint",
	label: "edit hint",
	repetitionsEnv: "HINT_AB_REPETITIONS",
	baseline: { settings: { editSiblingHint: false } },
	candidate: { settings: { editSiblingHint: true } },
});
