import { isCorrect, median, type RunRecord } from "./run-summary.ts";
import type { Manifest } from "./selection.ts";

// Side-by-side scorecard for several runs (one directory each). Correctness comes first and is never traded against the
// rest: efficiency is compared only on cases every run got right, so a model cannot look cheap by skipping the work or
// by answering wrongly. There is no combined score; each row is a separate tradeoff to read.

export type ComparedRun = { name: string; records: RunRecord[]; manifest?: Manifest };

type Column = { label: string; byCase: Map<string, RunRecord[]> };

function labelOf(run: ComparedRun): string {
	const first = run.records.find((record) => record.usage?.model);
	const model = first?.usage?.model ?? run.name;
	const thinking = first?.usage?.metadata?.thinkingLevel;
	return thinking ? `${model} @${thinking}` : model;
}

function group(records: RunRecord[]): Map<string, RunRecord[]> {
	const byCase = new Map<string, RunRecord[]>();
	for (const record of records) byCase.set(record.harness, [...(byCase.get(record.harness) ?? []), record]);
	return byCase;
}

const number = (value: number | undefined, digits = 0) => (value === undefined ? "-" : value.toFixed(digits));

type Metric = { name: string; pick: (record: RunRecord) => number | undefined; digits?: number };

const METRICS: Metric[] = [
	{ name: "tool calls", pick: (r) => r.usage?.toolCalls },
	{ name: "rounds", pick: (r) => r.usage?.metadata?.rounds },
	{
		name: "redundant calls",
		pick: (r) =>
			r.usage?.metadata?.duplicateCalls === undefined
				? undefined
				: r.usage.metadata.duplicateCalls + (r.usage.metadata.noNewEvidenceCalls ?? 0),
	},
	{ name: "tool errors", pick: (r) => r.usage?.metadata?.toolErrors },
	{ name: "input tokens", pick: (r) => r.usage?.inputTokens },
	{ name: "output tokens", pick: (r) => r.usage?.outputTokens },
	{ name: "cache-read tokens", pick: (r) => r.usage?.metadata?.cacheReadTokens },
	{
		name: "latency s",
		pick: (r) => (r.timings?.totalMs === undefined ? undefined : r.timings.totalMs / 1000),
		digits: 1,
	},
	{ name: "cost $", pick: (r) => r.usage?.metadata?.estimatedCostUsd, digits: 4 },
];

/** Median over cases of each case's median value, so a case with more repetitions does not weigh more. */
function medianOverCases(column: Column, cases: string[], pick: Metric["pick"]): number | undefined {
	const perCase = cases.flatMap((name) => {
		const values = (column.byCase.get(name) ?? []).flatMap((record) => pick(record) ?? []);
		const value = median(values);
		return value === undefined ? [] : [value];
	});
	return median(perCase);
}

export function compareRuns(runs: ComparedRun[]): string {
	const columns: Column[] = runs.map((run, index) => {
		const label = labelOf(run);
		const duplicated = runs.some((other, otherIndex) => otherIndex !== index && labelOf(other) === label);
		return { label: duplicated ? `${label} (${run.name})` : label, byCase: group(run.records) };
	});
	const lines: string[] = [];

	const inEvery = [...columns[0].byCase.keys()].filter((name) => columns.every((c) => c.byCase.has(name))).sort();
	const union = new Set(columns.flatMap((c) => [...c.byCase.keys()]));
	if (inEvery.length < union.size) {
		lines.push(
			`WARNING: ${union.size - inEvery.length} of ${union.size} cases are missing from at least one run and are left out. For a fair comparison run every model with the same selection: --replay <manifest.json> or --tier full.`,
			"",
		);
	}
	const manifests = runs.flatMap((run) => (run.manifest ? [run.manifest.cases.join(",")] : []));
	if (new Set(manifests).size > 1) lines.push("WARNING: the runs used different case selections.", "");

	const passedByAll = inEvery.filter((name) => columns.every((c) => (c.byCase.get(name) ?? []).every(isCorrect)));
	const head = (title: string) => [
		title,
		`| | ${columns.map((c) => c.label).join(" | ")} |`,
		`|---|${columns.map(() => "---").join("|")}|`,
	];

	lines.push(...head(`### Correctness (${inEvery.length} common cases)`));
	const rate = (c: Column, filter: (r: RunRecord) => boolean = () => true) => {
		const all = inEvery.flatMap((name) => c.byCase.get(name) ?? []).filter(filter);
		return `${all.filter(isCorrect).length}/${all.length}`;
	};
	lines.push(`| correct runs | ${columns.map((c) => rate(c)).join(" | ")} |`);
	lines.push(
		`| cases solved every time | ${columns.map((c) => `${inEvery.filter((name) => (c.byCase.get(name) ?? []).every(isCorrect)).length}/${inEvery.length}`).join(" | ")} |`,
	);
	const errors = (c: Column) =>
		inEvery.flatMap((name) => c.byCase.get(name) ?? []).filter((r) => (r.errors?.length ?? 0) > 0).length;
	lines.push(`| runs that errored or timed out | ${columns.map((c) => String(errors(c))).join(" | ")} |`);
	lines.push(
		`| provider retries | ${columns.map((c) => String(inEvery.flatMap((name) => c.byCase.get(name) ?? []).reduce((n, r) => n + (r.usage?.metadata?.autoRetries ?? 0), 0))).join(" | ")} |`,
	);
	const endings = (c: Column) => {
		const counts = new Map<string, number>();
		for (const r of inEvery.flatMap((name) => c.byCase.get(name) ?? [])) {
			const reason = r.usage?.metadata?.terminationReason ?? "unrecorded";
			counts.set(reason, (counts.get(reason) ?? 0) + 1);
		}
		return [...counts].map(([reason, count]) => `${reason} ${count}`).join(", ");
	};
	lines.push(`| how runs ended | ${columns.map(endings).join(" | ")} |`, "");

	lines.push(
		...head(`### Efficiency (median per case, only the ${passedByAll.length} cases every run solved every time)`),
	);
	if (passedByAll.length === 0) lines.push(`| (no case was solved by every run) |${columns.map(() => " |").join("")}`);
	else {
		for (const metric of METRICS) {
			lines.push(
				`| ${metric.name} | ${columns.map((c) => number(medianOverCases(c, passedByAll, metric.pick), metric.digits)).join(" | ")} |`,
			);
		}
	}
	lines.push("");

	lines.push(...head("### Per case: correct/runs, median tool calls, median seconds"));
	for (const name of inEvery) {
		const cells = columns.map((c) => {
			const records = c.byCase.get(name) ?? [];
			const calls = median(records.flatMap((r) => (r.usage?.toolCalls === undefined ? [] : [r.usage.toolCalls])));
			const seconds = median(
				records.flatMap((r) => (r.timings?.totalMs === undefined ? [] : [r.timings.totalMs / 1000])),
			);
			return `${records.filter(isCorrect).length}/${records.length}, ${number(calls)} calls, ${number(seconds)}s`;
		});
		lines.push(`| ${name} | ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}
