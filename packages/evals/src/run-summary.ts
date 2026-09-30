// Reads the `runs.jsonl` the eval reporter writes and turns it into a per-task, per-suite pass rate. "Passed" means the
// answer was correct: the judges' score is 1 when the record has one, otherwise the test status is used (the coding suites
// use judgeThreshold 1, so their status is correctness). A timeout or crash has neither and counts as a failure.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the harness records per run beyond tokens and cost (theoses-harness.ts, measureToolUse). Absent in older records. */
export type RunMetadata = {
	estimatedCostUsd?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	thinkingLevel?: string;
	rounds?: number;
	toolErrors?: number;
	duplicateCalls?: number;
	noNewEvidenceCalls?: number;
	autoRetries?: number;
	terminationReason?: string;
};

export type RunRecord = {
	harness: string;
	test: { status: string };
	/** Average judge score, 0..1. Absent in records written before the reporter recorded it. */
	score?: number;
	usage?: {
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		toolCalls?: number;
		metadata?: RunMetadata;
	};
	timings?: { totalMs?: number };
	errors?: unknown[];
};

export type TaskSummary = {
	task: string;
	runs: number;
	passed: number;
	medianTokens?: number;
	medianSeconds?: number;
	meanCostUsd?: number;
	medianToolCalls?: number;
};

export type SuiteSummary = { suite: string; runs: number; passed: number; tasks: TaskSummary[] };

/** Harness names are `coding-<task>`, `coding-hard-<task>`, `coding-recovery-<task>` (coding-suite.ts), `coding-replay-<task>` (coding-replay.eval.ts) and `plan-off-<task>` / `plan-on-<task>` (coding-plan-ab.eval.ts) and `task-off-<task>` / `task-on-<task>` (coding-task-ab.eval.ts) and `prompt-off-<task>` / `prompt-on-<task>` (coding-prompt-ab.eval.ts). */
export function suiteOf(harness: string): string {
	for (const prefix of [
		"coding-hard",
		"coding-recovery",
		"coding-replay",
		"plan-off",
		"plan-on",
		"task-off",
		"task-on",
		"prompt-off",
		"prompt-on",
		"hint-off",
		"hint-on",
		"snippet-off",
		"snippet-on",
		"diagnose",
		"smoke",
		"coding",
	]) {
		if (harness.startsWith(`${prefix}-`)) return prefix;
	}
	return harness;
}

export function isCorrect(record: RunRecord): boolean {
	return record.score !== undefined ? record.score >= 1 : record.test.status === "passed";
}

export function median(values: number[]): number | undefined {
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

/** Every `runs.jsonl` under a directory, parsed. An eval run directory has one; CI keeps one per pass. */
export function readRunRecords(directory: string): RunRecord[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return readRunRecords(path);
		return name === "runs.jsonl" ? parseRuns(readFileSync(path, "utf8")) : [];
	});
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
				medianToolCalls: median(runs.flatMap((r) => (r.usage?.toolCalls === undefined ? [] : [r.usage.toolCalls]))),
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
		lines.push(
			"| task | correct | median tokens | median s | mean cost | median calls |",
			"|---|---|---|---|---|---|",
		);
		for (const t of s.tasks) {
			lines.push(
				`| ${t.task} | ${t.passed}/${t.runs} | ${t.medianTokens ?? "-"} | ${t.medianSeconds?.toFixed(0) ?? "-"} | ${t.meanCostUsd === undefined ? "-" : `$${t.meanCostUsd.toFixed(4)}`} | ${t.medianToolCalls ?? "-"} |`,
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
