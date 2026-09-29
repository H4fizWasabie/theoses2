// Reads the `runs.jsonl` the eval reporter writes and turns it into a per-task, per-suite pass rate. "Passed" means the
// answer was correct: the judges' score is 1 when the record has one, otherwise the test status is used (the coding suites
// use judgeThreshold 1, so their status is correctness). A timeout or crash has neither and counts as a failure.

export type RunRecord = {
	harness: string;
	test: { status: string };
	/** Average judge score, 0..1. Absent in records written before the reporter recorded it. */
	score?: number;
	usage?: { totalTokens?: number; toolCalls?: number; metadata?: { estimatedCostUsd?: number } };
	timings?: { totalMs?: number };
};

export type TaskSummary = {
	task: string;
	runs: number;
	passed: number;
	medianTokens?: number;
	medianSeconds?: number;
	meanCostUsd?: number;
};

export type SuiteSummary = { suite: string; runs: number; passed: number; tasks: TaskSummary[] };

/** Harness names are `coding-<task>`, `coding-hard-<task>` (coding-suite.ts) and `plan-off-<task>` / `plan-on-<task>` (coding-plan-ab.eval.ts). */
export function suiteOf(harness: string): string {
	for (const prefix of ["coding-hard", "plan-off", "plan-on", "coding"]) {
		if (harness.startsWith(`${prefix}-`)) return prefix;
	}
	return harness;
}

function isCorrect(record: RunRecord): boolean {
	return record.score !== undefined ? record.score >= 1 : record.test.status === "passed";
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function parseRuns(jsonl: string): RunRecord[] {
	return jsonl
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as RunRecord);
}

export function summarizeRuns(records: RunRecord[]): SuiteSummary[] {
	const bySuite = new Map<string, Map<string, RunRecord[]>>();
	for (const record of records) {
		const suite = suiteOf(record.harness);
		const tasks = bySuite.get(suite) ?? new Map<string, RunRecord[]>();
		tasks.set(record.harness, [...(tasks.get(record.harness) ?? []), record]);
		bySuite.set(suite, tasks);
	}
	return [...bySuite].map(([suite, tasks]) => {
		const summaries: TaskSummary[] = [...tasks].map(([harness, runs]) => {
			const costs = runs.flatMap((r) =>
				r.usage?.metadata?.estimatedCostUsd === undefined ? [] : [r.usage.metadata.estimatedCostUsd],
			);
			const seconds = runs.flatMap((r) => (r.timings?.totalMs === undefined ? [] : [r.timings.totalMs / 1000]));
			return {
				task: harness.slice(suite.length + 1),
				runs: runs.length,
				passed: runs.filter(isCorrect).length,
				medianTokens: median(
					runs.flatMap((r) => (r.usage?.totalTokens === undefined ? [] : [r.usage.totalTokens])),
				),
				medianSeconds: median(seconds),
				meanCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined,
			};
		});
		return {
			suite,
			runs: summaries.reduce((n, t) => n + t.runs, 0),
			passed: summaries.reduce((n, t) => n + t.passed, 0),
			tasks: summaries,
		};
	});
}

export function formatSummary(suites: SuiteSummary[]): string {
	const lines: string[] = [];
	for (const s of suites) {
		lines.push(
			`### ${s.suite}: ${s.passed}/${s.runs} correct (${Math.round((s.passed / Math.max(1, s.runs)) * 100)}%)`,
			"",
		);
		lines.push("| task | correct | median tokens | median s | mean cost |", "|---|---|---|---|---|");
		for (const t of s.tasks) {
			lines.push(
				`| ${t.task} | ${t.passed}/${t.runs} | ${t.medianTokens ?? "-"} | ${t.medianSeconds?.toFixed(0) ?? "-"} | ${t.meanCostUsd === undefined ? "-" : `$${t.meanCostUsd.toFixed(4)}`} |`,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** One message per suite whose pass rate is under its floor (0..1), or whose runs are missing entirely. */
export function belowFloors(suites: SuiteSummary[], floors: Record<string, number>): string[] {
	const problems: string[] = [];
	for (const [suite, floor] of Object.entries(floors)) {
		const found = suites.find((s) => s.suite === suite);
		if (!found || found.runs === 0) {
			problems.push(`${suite}: no runs recorded`);
			continue;
		}
		const rate = found.passed / found.runs;
		if (rate < floor)
			problems.push(
				`${suite}: ${found.passed}/${found.runs} correct is below the floor of ${Math.round(floor * 100)}%`,
			);
	}
	return problems;
}
