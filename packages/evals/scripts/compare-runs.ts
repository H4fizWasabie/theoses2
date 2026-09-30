// Usage: node scripts/compare-runs.ts <run-dir> <run-dir> [...]
// Prints a side-by-side scorecard of eval runs (for example one per model), from the runs.jsonl and manifest.json each
// run directory holds. Run every model with the same selection (`npm run eval -- --replay <manifest.json>`) so the cases match.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareRuns } from "../src/run-compare.ts";
import { readRunRecords } from "../src/run-summary.ts";
import type { Manifest } from "../src/selection.ts";

const directories = process.argv.slice(2);
if (directories.length < 2) {
	console.error("Usage: node scripts/compare-runs.ts <run-dir> <run-dir> [...]");
	process.exit(2);
}

const runs = directories.map((directory) => {
	const path = resolve(directory);
	const manifestPath = join(path, "manifest.json");
	return {
		name: basename(path),
		records: readRunRecords(path),
		...(existsSync(manifestPath) ? { manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest } : {}),
	};
});
console.log(compareRuns(runs));
