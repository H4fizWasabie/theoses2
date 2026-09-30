// Usage: node scripts/plan-evals.ts [--tier smoke|rotate|full] [--seed <text|n>] [--date YYYY-MM-DD] [--horizon <days>]
// Shows which cases a run would pick, without calling a model. With --horizon it also walks that many consecutive
// rotation slots and lists how often each case is picked, so a case the rotation never reaches shows up here.
// Recent failures come from local run history and are not included.
import { evalCases } from "../src/case-registry.ts";
import { selectCases, slotFromSeed, staleCases, TIER_NAMES, type Tier } from "../src/selection.ts";

const options: Record<string, string> = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
	const flag = args[index];
	if (!["--tier", "--seed", "--date", "--horizon"].includes(flag) || args[index + 1] === undefined) {
		console.error("Usage: node scripts/plan-evals.ts [--tier smoke|rotate|full] [--seed <text|n>] [--date YYYY-MM-DD] [--horizon <days>]");
		process.exit(2);
	}
	options[flag.slice(2)] = args[index + 1];
}

const tier = (options.tier ?? "rotate") as Tier;
if (!TIER_NAMES.includes(tier)) {
	console.error(`Unknown tier "${tier}"; expected one of ${TIER_NAMES.join(", ")}.`);
	process.exit(2);
}
const date = options.date ?? new Date().toISOString().slice(0, 10);
const manifest = selectCases({ tier, date, seed: options.seed });

const list = (title: string, ids: string[]) => console.log(`${title} (${ids.length}): ${ids.join(", ") || "-"}`);
console.log(`tier=${manifest.tier} seed=${manifest.seed} slot=${manifest.slot} date=${manifest.date}`);
list("core", manifest.core);
list("new", manifest.newCases);
list("rotating", manifest.rotating);
console.log(`files: ${manifest.files.join(" ")}`);
console.log(`total: ${manifest.cases.length} of ${evalCases.filter((item) => !item.retired).length} active cases`);

const horizon = Number(options.horizon ?? "0");
if (horizon > 0 && tier !== "full") {
	const seen = new Map<string, number>();
	const categories = new Map<string, number>();
	const firstSlot = slotFromSeed(options.seed ?? date, date);
	for (let step = 0; step < horizon; step += 1) {
		// Successive slots, not successive dates: --seed text would otherwise repeat one slot.
		const planned = selectCases({ tier, date, seed: String(firstSlot + step) });
		for (const id of planned.cases) seen.set(id, (seen.get(id) ?? 0) + 1);
		const categoriesInRun = new Set(planned.cases.map((id) => evalCases.find((item) => `${item.suite}/${item.id}` === id)?.category));
		for (const category of categoriesInRun) categories.set(String(category), (categories.get(String(category)) ?? 0) + 1);
	}
	console.log(`\ncoverage over ${horizon} slots starting at slot ${firstSlot}:`);
	for (const item of evalCases.filter((candidate) => !candidate.retired)) {
		const id = `${item.suite}/${item.id}`;
		console.log(`  ${String(seen.get(id) ?? 0).padStart(3)}x  ${item.core ? "core " : "     "}${item.category.padEnd(13)} ${id}`);
	}
	const never = evalCases.filter((item) => !item.retired && !seen.has(`${item.suite}/${item.id}`));
	console.log(never.length > 0 ? `never picked: ${never.map((item) => item.id).join(", ")}` : "every active case is picked at least once");
	console.log(`runs covering each category: ${[...categories].map(([name, count]) => `${name} ${count}/${horizon}`).join(", ")}`);
}

const stale = staleCases(date);
if (stale.length > 0) console.log(`\nunreviewed for over 180 days: ${stale.join(", ")}`);
