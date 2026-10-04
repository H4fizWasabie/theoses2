import { describeCodingAb } from "./coding-suite.ts";

// Does a short working-discipline paragraph in the system prompt help? Adopted only if this shows a win (goal item 7).
// Same tasks, model and thinking level; only the appended paragraph differs. Comparative, so judgeThreshold is null.
export const DISCIPLINE = `

Working discipline:
- Read a file before you edit it, and read the code that calls or is called by what you change.
- Make the smallest change that fully fixes the problem. Do not refactor, rename or reformat what the task does not need.
- When you fix a bug, look for the same mistake in sibling code before you finish.
- Verify before you say you are done: run the relevant tests or command and look at the result.`;

describeCodingAb({
	arm: "prompt",
	label: "prompt",
	repetitionsEnv: "PROMPT_AB_REPETITIONS",
	baseline: {},
	candidate: { transformSystemPrompt: (prompt) => prompt + DISCIPLINE },
});
