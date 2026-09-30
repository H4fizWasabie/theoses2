import { describe, expect, it } from "vitest";
import { belowFloors, formatSummary, parseRuns, suiteOf, summarizeRuns } from "../src/run-summary.ts";

const run = (harness: string, status: string, tokens = 1000, ms = 30_000, cost = 0.001) =>
	JSON.stringify({
		harness,
		test: { status },
		usage: { totalTokens: tokens, metadata: { estimatedCostUsd: cost } },
		timings: { totalMs: ms },
	});

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
	});
});

describe("correctness comes from the judge score when a record has one", () => {
	it("counts a passed test with a score under 1 as wrong, and a missing score falls back to the status", () => {
		const withScore = (score: number) => JSON.stringify({ harness: "plan-on-t", test: { status: "passed" }, score });
		const [suite] = summarizeRuns(
			parseRuns(
				[withScore(1), withScore(0), withScore(0.5), run("plan-on-t", "passed"), run("plan-on-t", "failed")].join(
					"\n",
				),
			),
		);
		expect(suite).toMatchObject({ suite: "plan-on", runs: 5, passed: 2 });
	});
});

describe("summarizeRuns", () => {
	const records = parseRuns(
		[
			run("coding-a", "passed"),
			run("coding-a", "passed", 3000),
			run("coding-hard-b", "passed"),
			run("coding-hard-b", "failed"),
			run("coding-hard-b", "failed"),
			"",
		].join("\n"),
	);

	it("counts a task's correct runs and rolls them up per suite", () => {
		const [easy, hard] = summarizeRuns(records);
		expect(easy).toMatchObject({ suite: "coding", runs: 2, passed: 2 });
		expect(hard).toMatchObject({ suite: "coding-hard", runs: 3, passed: 1 });
		expect(hard.tasks[0]).toMatchObject({ task: "b", runs: 3, passed: 1 });
	});

	it("reports median tokens and mean cost", () => {
		const [easy] = summarizeRuns(records);
		expect(easy.tasks[0]).toMatchObject({ medianTokens: 3000, meanCostUsd: 0.001 });
	});

	it("copes with a run that recorded no usage, as a timeout does", () => {
		const [suite] = summarizeRuns(parseRuns(JSON.stringify({ harness: "coding-a", test: { status: "failed" } })));
		expect(suite.tasks[0]).toMatchObject({ runs: 1, passed: 0, medianTokens: undefined, meanCostUsd: undefined });
	});
});

describe("formatSummary and belowFloors", () => {
	const suites = summarizeRuns(
		parseRuns([run("coding-a", "passed"), run("coding-hard-b", "passed"), run("coding-hard-b", "failed")].join("\n")),
	);

	it("prints a markdown table per suite", () => {
		const text = formatSummary(suites);
		expect(text).toContain("### coding-hard: 1/2 correct (50%)");
		expect(text).toContain("| b | 1/2 |");
	});

	it("names each suite under its floor, and a suite with no runs", () => {
		expect(belowFloors(suites, { coding: 1, "coding-hard": 0.7 })).toEqual([
			"coding-hard: 1/2 correct is below the floor of 70%",
		]);
		expect(belowFloors(suites, { missing: 0.5 })).toEqual(["missing: no runs recorded"]);
		expect(belowFloors(suites, { coding: 1, "coding-hard": 0.5 })).toEqual([]);
	});
});
