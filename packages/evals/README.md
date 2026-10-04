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

With no other arguments this runs the `smoke` tier (below), a few minutes. To run specific files, name them; other arguments are
forwarded to Vitest, and every case in those files runs:

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

Each invocation prints an ignored `.eval/` artifact directory. `runs.jsonl` indexes completed harness runs and their
native Theoses session JSONL attachments under `sessions/`. These files may contain prompts, responses, source code, and tool
output.

## Tiers

Three levels, so the eval you run while developing is not the eval you run before a release:

| Tier | Runs | Use it for | Time (GLM 5.3 flash) |
|---|---|---|---|
| `smoke` (default) | the 6 core cases, 2 rotating cases, the recent failures (up to 3), and `smoke.eval.ts` | every change to the agent loop, tools or prompt | about 5 min (measured 4m44s with 8 coding cases) |
| `rotate` | core, 8 rotating cases (at least one per category, more where a category has a single non-core case), recent failures (up to 5), cases added in the last 14 days, and `smoke.eval.ts` | before merging a larger change; a different slice each day | about 10 min (estimate, not yet measured) |
| `full` | every active case, `smoke.eval.ts` and `extensions.eval.ts` | runtime or provider changes, releases, model bake-offs | 35 to 45 min on slower models |

```bash
npm run eval -- --tier smoke  --provider openrouter --model z-ai/glm-5.3-flash
npm run eval -- --tier rotate --provider openrouter --model z-ai/glm-5.3-flash
npm run eval -- --tier full   --provider openrouter --model z-ai/glm-5.3-flash
```

The A/B experiment files (`coding-*-ab.eval.ts`, `batching.eval.ts`, `cache-prefix.eval.ts`) are not part of any tier. Name them
explicitly. Before tiers, a bare `npm run eval` ran all of them, roughly 480 runs.

**What is picked and why.** `src/case-registry.ts` has one row per coding case: its category (`bugfix`, `root-cause`,
`investigation`, `refactor`, `implement`, `recovery`, `replay`), whether it is `core`, and its lifecycle. `src/selection.ts` turns
`(tier, date, seed, recent failures)` into a manifest, deterministically:

- **core**: pinned into every tier; one cheap case per category. A core failure should mean something broke.
- **rotating**: the non-core cases are interleaved round-robin across categories and each run takes the next window of that
  sequence. The window starts at `slot * count`, so consecutive slots tile the sequence and every case is picked within
  `ceil(pool / count)` slots. The slot is the day number, so `rotate` reaches the whole pool in about three days. `smoke` skips
  cases marked `slow` (replay) in its rotation. `rotate` adds one case for any category its window missed.
- **recent failures**: cases whose latest run, for the same model, in the last 10 local run directories was wrong. CI has no
  history, so this only applies to local runs.
- **new cases**: a case with `added` in the last 14 days always runs in `rotate`.

**Reproducing a run.** Every tiered run writes `manifest.json` into its artifact directory: tier, seed, slot, date, and the exact
case ids with the reason each was chosen. Replay the same cases, for example on another model:

```bash
npm run eval -- --replay .eval/<run>/manifest.json --provider openai --model gpt-5.6-sol
npm run eval -- --tier rotate --seed release-1.1     # a named seed: same cases every time it is used
npm run eval -- --tier rotate --date 2026-10-05      # the selection for a given day
```

A replay fails up front if the manifest names a case that no longer exists. Editing a copy of the manifest's `cases` (and
`files`) reruns just those cases.

**Look before you run.** From `packages/evals`, `plan-evals` prints the selection without calling a model, and with `--horizon` checks that the rotation
reaches every case:

```bash
node scripts/plan-evals.ts --tier rotate --horizon 7
```

## Comparing models

Run every model with the same selection, then compare the run directories:

```bash
npm run eval -- --tier full --provider openrouter --model z-ai/glm-5.3-flash      # note the printed .eval/<run-a>
npm run eval -- --replay .eval/<run-a>/manifest.json --provider openai --model gpt-5.6-sol
node scripts/compare-runs.ts .eval/<run-a> .eval/<run-b>
```

The scorecard has three parts and no combined score:

1. **Correctness** on the cases present in every run: correct runs, cases solved every time, runs that errored, provider retries,
   and how runs ended.
2. **Efficiency**: median tool calls, rounds, redundant calls, tool errors, tokens (input, output, cache read), latency and cost,
   taken only over the cases every run solved every time. A model cannot look cheaper by skipping work or answering wrongly;
   its misses show up in part 1.
3. **Per case**: correct/runs, median tool calls and seconds, for spotting where two models differ.

The scorecard warns when the runs used different case sets or the models ran at different thinking levels (`@max` in the column
heading; runs from before it was recorded show none).

## Metrics recorded per run

`runs.jsonl` keeps, per run: provider, model, `thinkingLevel`, input/output/cache tokens, estimated cost, latency, judge score,
errors, and the following in `usage`:

| Field | Meaning |
|---|---|
| `toolCalls`, `rounds` | tool calls, and model requests (assistant messages) |
| `toolErrors` | tool results flagged as errors |
| `duplicateCalls` | a read-only call (`read`, `grep`, `find`, `ls`) identical to an earlier one with no other tool call in between |
| `noNewEvidenceCalls` | a different read-only call whose result (80 characters or more) equals an earlier result in the same window |
| `autoRetries` | provider errors the session retried |
| `terminationReason` | stop reason of the last assistant message (`stop` is a normal finish) |

Any tool call that is not read-only (`edit`, `write`, `bash`, ...) starts a new window, so re-reading a file to check an edit is
not redundant. A failed call is never redundant, so retrying after an error is recovery. These describe how the agent got its
answer; correctness always comes from the grader. **Not measured**: semantically redundant investigation (a different question
with the same answer) and evidence quality, which need a judge; correct stopping is only visible through `rounds` and
`terminationReason`.

## Coding evals and their pass rate

`src/coding.eval.ts` (5 easy tasks) and `src/coding-hard.eval.ts` (13 hard ones) seed a tiny Node project, give the agent one
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

The first baseline (GLM 5.3 flash, thinking `max`, task plan off): easy 15/15, hard 26/33. gpt-6-luna was tried as the production model on 2026-09-30 (hard 25/26, replay 16/16 with the sibling hint on) and dropped for GLM 5.3 flash: about 40% slower and dearer per run for a gain on one task. The CI workflow tracks GLM; pass the `model` input to measure another model.

CI pins the model to the providers production routes it to (GLM 5.3 flash: GMICloud then Novita at fp8, no fallback), from `models.production.json`; the workflow's `providers: open` input lets OpenRouter choose instead. Runs before 2026-10-04 were not pinned. Update the file when production's pin changes.

## Keeping the suite from going stale

- **Rotation** keeps every non-core case in play (above); `plan-evals --horizon` shows any case it fails to reach.
- **Turning a failure into a regression case.** Fix the bug with a regression test that fails on an assertion at the parent
  commit, then add a `ReplayTask` to `src/replay-tasks.ts` and a row to `src/case-registry.ts` (`category: "replay"`,
  `slow: true`, `origin: "regression"`, `added: "<today>"`). `test/case-registry.test.ts` fails when a task has no row, and
  `test/replay-tasks.test.ts` proves the task is solvable. For a bug that is not a git fix, add a `CodingTask` to the matching
  `coding-tasks-*.ts` the same way. Until it is a case, a failing local run is re-run by the next `smoke`/`rotate` anyway.
- **Retiring a case.** Set `retired: "<why>"` on its row. It leaves every tier but stays in the fixture tests. Do not delete a
  task to save time; a case that is too slow for `smoke` gets `slow: true`, and one that no longer separates models loses `core`.
- **Review.** Set `reviewed: "<date>"` on a row when someone confirms the case still tests something real. `plan-evals` lists
  active cases unreviewed for 180 days.
- **Adding a case** is a task in a `coding-tasks-*.ts` file plus a registry row. Pick the category by the capability it
  separates models on; give it `core` only if it is cheap and reliably passes.

## Evals in CI

`.github/workflows/evals.yml` still names the four coding files (so it is an ad hoc run of every case, not a tier) and runs them against the production model on demand (`workflow_dispatch`, with 1 to 3
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
