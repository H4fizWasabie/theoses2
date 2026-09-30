import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/run-compare.ts";
import type { RunRecord } from "../src/run-summary.ts";

function record(
	harness: string,
	model: string,
	over: { score?: number; calls?: number; seconds?: number; redundant?: number } = {},
): RunRecord {
	return {
		harness,
		test: { status: "passed" },
		score: over.score ?? 1,
		usage: {
			model,
			inputTokens: 1000,
			outputTokens: 100,
			totalTokens: 1100,
			toolCalls: over.calls ?? 5,
			metadata: {
				thinkingLevel: "max",
				rounds: 4,
				toolErrors: 0,
				duplicateCalls: over.redundant ?? 0,
				noNewEvidenceCalls: 0,
				estimatedCostUsd: 0.001,
				terminationReason: "stop",
			},
		},
		timings: { totalMs: (over.seconds ?? 10) * 1000 },
	};
}

describe("compareRuns", () => {
	it("shows a cheaper model that solves less as less correct, not as better", () => {
		const text = compareRuns([
			{
				name: "a",
				records: [record("coding-x", "big", { calls: 12 }), record("coding-y", "big", { calls: 14 })],
			},
			{
				name: "b",
				records: [record("coding-x", "small", { calls: 3 }), record("coding-y", "small", { score: 0, calls: 2 })],
			},
		]);
		expect(text).toContain("| | big @max | small @max |");
		expect(text).toContain("| correct runs | 2/2 | 1/2 |");
		// Efficiency only over the case both solved: coding-x, where small used 3 calls against 12.
		expect(text).toContain("only the 1 cases every run solved every time");
		expect(text).toContain("| tool calls | 12 | 3 |");
	});

	it("counts redundant calls as duplicates plus no-new-evidence calls", () => {
		const text = compareRuns([
			{ name: "a", records: [record("coding-x", "m1", { redundant: 4 })] },
			{ name: "b", records: [record("coding-x", "m2", { redundant: 0 })] },
		]);
		expect(text).toContain("| redundant calls | 4 | 0 |");
	});

	it("warns and leaves out cases that are not in every run", () => {
		const text = compareRuns([
			{ name: "a", records: [record("coding-x", "m1"), record("coding-y", "m1")] },
			{ name: "b", records: [record("coding-x", "m2")] },
		]);
		expect(text).toContain("WARNING: 1 of 2 cases are missing from at least one run");
		expect(text).toContain("Correctness (1 common cases)");
	});

	it("keeps two runs of the same model apart by directory name", () => {
		const text = compareRuns([
			{ name: "run-1", records: [record("coding-x", "m")] },
			{ name: "run-2", records: [record("coding-x", "m")] },
		]);
		expect(text).toContain("m @max (run-1) | m @max (run-2)");
	});
});
