import { describe, expect, it } from "vitest";
import { belowFloors, formatSummary, parseRuns, suiteOf, summarizeRuns } from "../src/run-summary.ts";

const run = (harness: string, status: string, tokens = 1000, ms = 30_000, cost = 0.001) =>
	JSON.stringify({
		harness,
		test: { status },
		usage: { totalTokens: tokens, metadata: { estimatedCostUsd: cost } },
		timings: { totalMs: ms },
	});

// Real task ids: the suite is the harness name without a known task id.
const EASY = "coding-fix-off-by-one";
const HARD = "coding-hard-sibling-sort-bug";

describe("suiteOf", () => {
	it("tells the hard suite from the easy one by harness name", () => {
		expect(suiteOf("coding-fix-off-by-one")).toBe("coding");
		expect(suiteOf("coding-hard-sibling-sort-bug")).toBe("coding-hard");
		expect(suiteOf("cache-prefix")).toBe("cache-prefix");
	});

	it("does not fold the edit-recovery tasks into the easy suite and its floor", () => {
		expect(suiteOf("coding-recovery-edit-duplicate-line")).toBe("coding-recovery");
		expect(suiteOf("coding-replay-auto-resume-timer-leak")).toBe("coding-replay");
	});

	it("keeps the two arms of the plan A/B apart", () => {
		expect(suiteOf("plan-off-sibling-sort-bug")).toBe("plan-off");
		expect(suiteOf("plan-on-sibling-sort-bug")).toBe("plan-on");
		expect(suiteOf("task-off-sibling-sort-bug")).toBe("task-off");
		expect(suiteOf("task-on-sibling-sort-bug")).toBe("task-on");
		expect(suiteOf("prompt-on-sibling-sort-bug")).toBe("prompt-on");
		expect(suiteOf("diagnose-sibling-sort-bug")).toBe("diagnose");
		expect(suiteOf("hint-on-sibling-sort-bug")).toBe("hint-on");
		expect(suiteOf("snippet-on-sibling-sort-bug")).toBe("snippet-on");
		expect(suiteOf("smoke-basic-prompt")).toBe("smoke");
	});

	it("strips the longest known task id, so a new A/B arm needs no registration", () => {
		expect(suiteOf("brandnew-on-sibling-sort-bug-unstated")).toBe("brandnew-on");
		expect(suiteOf("hint-off-sibling-sort-bug-unstated")).toBe("hint-off");
		expect(suiteOf("snippet-off-replay-auto-resume-timer-leak")).toBe("snippet-off-replay");
	});

	it("keeps a name that ends with no known task id whole", () => {
		expect(suiteOf("plan-on-unknown-task")).toBe("plan-on-unknown-task");
		expect(suiteOf("default-prompt")).toBe("default-prompt");
		expect(suiteOf("sibling-sort-bug")).toBe("sibling-sort-bug");
	});
});

describe("correctness comes from the judge score when a record has one", () => {
	it("counts a passed test with a score under 1 as wrong, and a missing score falls back to the status", () => {
		const harness = "plan-on-sibling-sort-bug";
		const withScore = (score: number) => JSON.stringify({ harness, test: { status: "passed" }, score });
		const [suite] = summarizeRuns(
			parseRuns(
				[withScore(1), withScore(0), withScore(0.5), run(harness, "passed"), run(harness, "failed")].join("\n"),
			),
		);
		expect(suite).toMatchObject({ suite: "plan-on", runs: 5, passed: 2 });
	});
});

describe("summarizeRuns", () => {
	const records = parseRuns(
		[
			run(EASY, "passed"),
			run(EASY, "passed", 3000),
			run(HARD, "passed"),
			run(HARD, "failed"),
			run(HARD, "failed"),
			"",
		].join("\n"),
	);

	it("counts a task's correct runs and rolls them up per suite", () => {
		const [easy, hard] = summarizeRuns(records);
		expect(easy).toMatchObject({ suite: "coding", runs: 2, passed: 2 });
		expect(hard).toMatchObject({ suite: "coding-hard", runs: 3, passed: 1 });
		expect(hard.tasks[0]).toMatchObject({ task: "sibling-sort-bug", runs: 3, passed: 1 });
	});

	it("reports median tokens and mean cost", () => {
		const [easy] = summarizeRuns(records);
		expect(easy.tasks[0]).toMatchObject({ medianTokens: 3000, meanCostUsd: 0.001 });
	});

	it("copes with a run that recorded no usage, as a timeout does", () => {
		const [suite] = summarizeRuns(parseRuns(JSON.stringify({ harness: EASY, test: { status: "failed" } })));
		expect(suite.tasks[0]).toMatchObject({ runs: 1, passed: 0, medianTokens: undefined, meanCostUsd: undefined });
	});
});

describe("formatSummary and belowFloors", () => {
	const suites = summarizeRuns(parseRuns([run(EASY, "passed"), run(HARD, "passed"), run(HARD, "failed")].join("\n")));

	it("prints a markdown table per suite", () => {
		const text = formatSummary(suites);
		expect(text).toContain("### coding-hard: 1/2 correct (50%)");
		expect(text).toContain("| sibling-sort-bug | 1/2 |");
	});

	it("names each suite under its floor, and a suite with no runs", () => {
		expect(belowFloors(suites, { coding: 1, "coding-hard": 0.7 })).toEqual([
			"coding-hard: 1/2 correct is below the floor of 70%",
		]);
		expect(belowFloors(suites, { missing: 0.5 })).toEqual(["missing: no runs recorded"]);
		expect(belowFloors(suites, { coding: 1, "coding-hard": 0.5 })).toEqual([]);
	});
});
