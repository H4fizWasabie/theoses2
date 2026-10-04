import { describe, expect, it, vi } from "vitest";
import { describeEval } from "vitest-evals";
import { describeCodingAb } from "../src/coding-suite.ts";
import { hardTasks } from "../src/coding-tasks-hard.ts";
import { replayTasks } from "../src/replay-tasks.ts";

// Record the evals the helper would register instead of running a model.
vi.mock("vitest-evals", async (importOriginal) => ({
	...(await importOriginal<object>()),
	describeEval: vi.fn(),
}));
vi.mock("../src/theoses-harness.ts", () => ({
	createTheosesCodingAgentHarness: ({ name }: { name: string }) => ({ name, run: vi.fn() }),
}));
vi.mock("../src/replay-grader.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	hasCommit: () => true,
}));

describe("describeCodingAb", () => {
	// A placeholder test, since vitest fails a describe block with none.
	vi.mocked(describeEval).mockImplementation((title) => describe(title, () => it("is registered", () => {})));
	describeCodingAb({
		arm: "snippet",
		label: "edit snippet",
		repetitionsEnv: "UNSET_AB_REPETITIONS",
		tasks: hardTasks.slice(0, 1),
		replays: replayTasks.slice(0, 1),
		baseline: { settings: { editSnippet: false } },
		candidate: { settings: { editSnippet: true } },
	});

	it("names the arms <arm>-off/on-<task> and titles each eval as the A/B files did", () => {
		const registered = vi.mocked(describeEval).mock.calls.map(([title, { harness }]) => [title, harness.name]);
		const task = hardTasks[0].id;
		const replay = `replay-${replayTasks[0].id}`;
		// Three repetitions by default, baseline then candidate in each.
		expect(registered).toEqual([
			...Array.from({ length: 3 }, () => [
				[`Edit snippet A/B ${task}`, `snippet-off-${task}`],
				[`Edit snippet A/B ${task}`, `snippet-on-${task}`],
			]).flat(),
			...Array.from({ length: 3 }, () => [
				[`Edit snippet A/B ${replay}`, `snippet-off-${replay}`],
				[`Edit snippet A/B ${replay}`, `snippet-on-${replay}`],
			]).flat(),
		]);
	});
});
