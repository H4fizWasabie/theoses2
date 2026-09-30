# Theoses evals

Theoses evals are behavioral, model-backed checks for Theoses workflows. They adapt a real `AgentSession` to `vitest-evals`, run
it in isolated temporary project and agent directories, and attach native Theoses session artifacts.
Use them to measure end-to-end behavior and compare prompts, tools, skills, models, or other harness configurations.

## Running evals

Run from the repository root with a default provider and model:

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
```

The equivalent environment variables are:

```bash
THEOSES_PROVIDER=openai THEOSES_MODEL=gpt-5.6-sol npm run eval
```

CLI values take precedence and become defaults for harnesses that do not select a model explicitly. Provider and model must be supplied together. The runner also allows no default when every executed harness configures its own model.
Authentication comes from Theoses's normal `ModelRuntime`, including Theoses subscription credentials and provider API-key
environment variables.

Additional arguments are forwarded to Vitest:

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

Each invocation prints an ignored `.eval/` artifact directory. `runs.jsonl` indexes completed harness runs and their
native Theoses session JSONL attachments under `sessions/`. These files may contain prompts, responses, source code, and tool
output.

## Coding evals and their pass rate

`src/coding.eval.ts` (5 easy tasks) and `src/coding-hard.eval.ts` (12 hard ones) seed a tiny Node project, give the agent one
prompt, and grade the workspace by running `node --test`, including grader-owned hidden tests the agent never sees. A wrong
answer fails its test (`judgeThreshold: 1`), so the pass rate is a correctness rate. Every task has a reference solution, and
`test/coding-tasks.test.ts` proves each one fails as seeded and passes solved.

`src/coding-recovery.eval.ts` (3 tasks) is set up so the obvious first edit is rejected by the edit tool (duplicate target line,
whitespace differing from the prompt, a value the prompt describes wrongly), and scores whether the agent recovers.

`src/coding-replay.eval.ts` replays real fixes from this repository (`src/replay-tasks.ts`). The workspace is a `git archive` of
the fix commit's parent with the installed `node_modules` linked in, the prompt is the bug as reported, and the grader is the
regression test that fix added, written into the workspace after the run. `test/replay-tasks.test.ts` proves each task's test
fails at the parent and passes with the fix's source files. It needs the fix commits, so it skips in a shallow clone, and the
eval workflow checks out full history. To add a task, pick a fix whose test fails on an assertion at the parent (not on a name the
agent could not guess) and write the prompt from the issue, not from the diff.

Summarize any run directory, with optional floors that make the exit code 1:

```bash
node scripts/summarize-runs.ts .eval/<run> --floor coding=0.85 --floor coding-hard=0.7 --floor coding-recovery=0.7 --floor coding-replay=0.5
```

The first baseline on the production model (GLM 5.3 flash, thinking `max`, task plan off): easy 15/15, hard 26/33.

## Evals in CI

`.github/workflows/evals.yml` runs both suites against the production model on demand (`workflow_dispatch`, with 1 to 3
passes) and every Monday. It never runs on pull requests, because a public repo must not give a paid key to PR code. It needs
the `OPENROUTER_API_KEY` Actions secret, which should have a hard credit limit on the OpenRouter side; a run costs a few cents.
The job summary shows the per-task table, the run records are uploaded as the `eval-runs` artifact, and the job fails when the
easy set drops below 85%, the hard set below 70%, the recovery set below 70% or the replay set below 50%. Those floors sit under the first baseline and should rise as the agent improves.

## Writing evals

Follow [`vitest-evals`](https://github.com/getsentry/vitest-evals) for general suite, judge, assertion, and normalized
trace guidance. Theoses-specific evals use `createTheosesCodingAgentHarness(...)` from `src/theoses-harness.ts`, with one harness bound
to each `describeEval(...)` suite:

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

const harness = createTheosesCodingAgentHarness({ noTools: "all" });

describeEval("Theoses smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### Configuring the Theoses harness

`createTheosesCodingAgentHarness(...)` accepts:

- `name`: stable harness identity used by reports and comparisons.
- `model`: optional `{ provider, id }` selection. It overrides the runner's default model.
- `noTools`: Theoses's tool-disable configuration.
- `transformSystemPrompt`: transforms the complete default prompt before the eval starts.
- `output`: transforms the final response and `AgentSession` into a JSON-safe domain result.

An explicitly selected model makes model-comparison harnesses independent of the runner default:

```ts
const harness = createTheosesCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

A run accepts either one prompt or a sequence of prompt and reload steps. Reload steps are useful when the preceding
prompt creates or changes Theoses resources:

```ts
const result = await run([
	{ type: "prompt", content: "Create a Theoses extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### Transforming harness output

Use `output` to expose scenario-specific, JSON-safe behavior without adding that behavior to the generic Theoses adapter:

```ts
const harness = createTheosesCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

Assert application behavior on `result.output`. Assert model and tool traces on `result.session`, using
`vitest-evals` helpers such as `toolCalls(...)`.

### Writing comparative eval sets

Use `evalHarnessTable(...)` with Vitest's native `describe.for(...)` to run the same inputs against multiple harnesses.
Harnesses may differ by prompt, tools, skills, model, or any other Theoses configuration:

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

Comparative suites should record correctness with deterministic or model-backed judges and set `judgeThreshold: null`.
This keeps a low score as an observation instead of making the Vitest invocation fail. Use hard assertions only for
suite invariants and infrastructure contracts. `expect.soft(...)` still fails the test and is not a scoring mechanism.

The Theoses harness snapshots native session JSONL before deleting its temporary workspace. An eval-only `afterEach` hook
registers that snapshot against the explicit Vitest test task before reporters run.

Harness names must be stable and unique within an eval set. The grouping key combines repetition with a non-empty string
`input.id` when available, otherwise with a SHA-256 hash of strict canonical JSON input. Use `candidate` for one treatment
or `candidates` for multiple treatments. Each candidate is compared only with the declared baseline. For each matched
input and repetition, the reporter computes pass-rate lift from each run's recorded average judge score, treating a score
of at least `1` as passing. Lift is the candidate pass rate minus the baseline pass rate, in percentage points. Missing
judge scores are reported as incomplete observations. Tokens, latency, and estimated cost remain separate
candidate-minus-baseline paired deltas; missing telemetry remains unavailable. If execution-order randomization becomes
necessary, use Vitest's built-in sequence shuffling.

See the [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) guidance for comparative-eval methodology,
repetition strategy, trustworthy judges, and telemetry interpretation.
