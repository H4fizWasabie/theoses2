// Usage: node scripts/summarize-runs.ts <dir> [--floor <suite>=<0..1>]...
// Reads every runs.jsonl under <dir>, prints a per-task, per-suite pass rate (and appends it to the GitHub step summary
// when running in Actions), and exits 1 when a suite is under its floor.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { belowFloors, formatSummary, parseRuns, summarizeRuns } from "../src/run-summary.ts";

const [directory, ...rest] = process.argv.slice(2);
if (!directory) {
	console.error("Usage: node scripts/summarize-runs.ts <dir> [--floor <suite>=<0..1>]...");
	process.exit(2);
}

const floors: Record<string, number> = {};
for (let i = 0; i < rest.length; i += 2) {
	const [suite, value] = (rest[i + 1] ?? "").split("=");
	const floor = Number(value);
	if (rest[i] !== "--floor" || !suite || !Number.isFinite(floor)) {
		console.error(`Bad argument near "${rest[i]} ${rest[i + 1] ?? ""}"; expected --floor <suite>=<0..1>`);
		process.exit(2);
	}
	floors[suite] = floor;
}

function runFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return runFiles(path);
		return name === "runs.jsonl" ? [path] : [];
	});
}

const records = runFiles(directory).flatMap((file) => parseRuns(readFileSync(file, "utf8")));
const text = formatSummary(summarizeRuns(records));
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

const problems = belowFloors(summarizeRuns(records), floors);
for (const problem of problems) console.error(`FLOOR: ${problem}`);
process.exit(problems.length > 0 ? 1 : 0);
