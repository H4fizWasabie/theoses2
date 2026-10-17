// Usage: node scripts/grounded-share.ts <sessions-dir> [--db <eval.db>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Scores every recorded session under <sessions-dir> (copies are deduped by entry id), then prints per model per day:
// replies, specific Claims, Grounded share, Guesses, small Claims (untrusted), and with --db the prompt-cache ratio. Runs offline; no model is called.
import { aggregate, cacheRatios, formatTable, loadCorpus, scoreSession } from "../src/grounded-share.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const directory = args.find((arg, i) => !arg.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!directory) {
	console.error("Usage: node scripts/grounded-share.ts <sessions-dir> [--db <eval.db>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
	process.exit(2);
}

const corpus = loadCorpus(directory);
const scores = corpus.sessions.flatMap(scoreSession);
const rows = aggregate(scores, { from: option("--from"), to: option("--to") });
const db = option("--db");
const cache = db ? cacheRatios(db) : undefined;

console.log(
	`scanned ${corpus.files} files, ${corpus.entries} entries, ${corpus.duplicates} duplicate entries dropped, ${corpus.sessions.length} sessions, ${scores.length} replies`,
);
console.log(formatTable(rows, cache));
