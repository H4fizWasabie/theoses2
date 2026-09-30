import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	caseId,
	caseOfHarness,
	type EvalCase,
	EXTRA_FILES,
	evalCases,
	REGISTRY_CREATED,
	SUITE_FILES,
	type Suite,
} from "./case-registry.ts";
import { isCorrect, parseRuns } from "./run-summary.ts";

// Picks which cases a run executes. A pure function of (registry, tier, slot, date, recent failures), so the same
// inputs always give the same cases, and the manifest written next to the run records them for an exact replay.
//
//   smoke  = core + 2 rotating + recent failures (up to 3)               fast feedback, a few minutes
//   rotate = core + 8 rotating + recent failures (up to 5) + new cases   broader, a different slice each day
//   full   = every active case + the extension eval                      deep regression and model comparison

export type Tier = "smoke" | "rotate" | "full";

export const TIER_NAMES: readonly Tier[] = ["smoke", "rotate", "full"];

const TIER_SETTINGS = {
	smoke: { rotating: 2, failures: 3, coverageFloor: false, newCases: false, skipSlow: true },
	rotate: { rotating: 8, failures: 5, coverageFloor: true, newCases: true, skipSlow: false },
} as const;

const NEW_CASE_DAYS = 14;
const REVIEW_DAYS = 180;
const HISTORY_RUNS = 10;

export type Manifest = {
	schemaVersion: 1;
	tier: Tier;
	/** What `--seed` was, or the date when none was given. */
	seed: string;
	/** The rotation position derived from the seed. Same slot, same rotating cases. */
	slot: number;
	date: string;
	/** Case ids (`suite/id`) in run order: core, new, recent failures, rotating. */
	cases: string[];
	core: string[];
	newCases: string[];
	recentFailures: string[];
	rotating: string[];
	/** Eval files to run: the suites that have a selected case, plus the extras for the tier. */
	files: string[];
	/** Set on a manifest written by `--replay`: the manifest it copied. */
	replayOf?: string;
};

export function dayNumber(isoDate: string): number {
	const ms = Date.parse(`${isoDate}T00:00:00Z`);
	if (Number.isNaN(ms)) throw new Error(`Not an ISO date (YYYY-MM-DD): ${isoDate}`);
	return Math.floor(ms / 86_400_000);
}

/** No seed: the day number, so the rotation moves daily. A number is used as the slot; any other text is hashed. */
export function slotFromSeed(seed: string, date: string): number {
	if (seed === date) return dayNumber(date);
	if (/^\d+$/.test(seed)) return Number(seed);
	let hash = 2166136261;
	for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
	return hash;
}

/** Round-robin across categories (sorted), each category's cases sorted by id. */
export function interleaveByCategory(pool: readonly EvalCase[]): EvalCase[] {
	const groups = new Map<string, EvalCase[]>();
	for (const item of [...pool].sort((a, b) => a.id.localeCompare(b.id))) {
		groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
	}
	const lists = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list);
	const order: EvalCase[] = [];
	for (let round = 0; order.length < pool.length; round += 1) {
		for (const list of lists) if (round < list.length) order.push(list[round]);
	}
	return order;
}

/**
 * The next `count` cases of the interleaved pool, starting at slot*count and wrapping. Successive slots tile the
 * sequence, so every pool case is picked within ceil(pool/count) consecutive slots. With `coverageFloor`, a category
 * the window missed gets one case anyway, so no category goes unsampled in a run.
 */
export function rotate(pool: readonly EvalCase[], count: number, slot: number, coverageFloor: boolean): EvalCase[] {
	const order = interleaveByCategory(pool);
	if (order.length === 0 || count <= 0) return [];
	const size = Math.min(count, order.length);
	const start = (slot * size) % order.length;
	const picked = Array.from({ length: size }, (_, offset) => order[(start + offset) % order.length]);
	if (coverageFloor) {
		for (const category of new Set(order.map((item) => item.category))) {
			if (picked.some((item) => item.category === category)) continue;
			const ofCategory = order.filter((item) => item.category === category);
			picked.push(ofCategory[slot % ofCategory.length]);
		}
	}
	return picked;
}

function daysBetween(fromIso: string, toIso: string): number {
	return dayNumber(toIso) - dayNumber(fromIso);
}

export type SelectOptions = {
	tier: Tier;
	/** ISO date the run is for. */
	date: string;
	seed?: string;
	/** Case ids (`suite/id`) that failed in recent runs, most recent first (see `readRecentFailures`). */
	recentFailures?: readonly string[];
	cases?: readonly EvalCase[];
};

export function selectCases(options: SelectOptions): Manifest {
	const { tier, date, cases = evalCases } = options;
	const seed = options.seed ?? date;
	const slot = slotFromSeed(seed, date);
	const active = cases.filter((item) => !item.retired);
	const id = (item: EvalCase) => caseId(item.suite, item.id);
	const core = active.filter((item) => item.core);

	let newCases: EvalCase[] = [];
	let failures: EvalCase[] = [];
	let rotating: EvalCase[] = [];
	if (tier === "full") {
		rotating = active.filter((item) => !item.core);
	} else {
		const settings = TIER_SETTINGS[tier];
		if (settings.newCases) {
			newCases = active.filter(
				(item) =>
					!item.core &&
					item.added !== undefined &&
					daysBetween(item.added, date) >= 0 &&
					daysBetween(item.added, date) <= NEW_CASE_DAYS,
			);
		}
		const known = new Set(active.filter((item) => !item.core).map(id));
		failures = (options.recentFailures ?? [])
			.filter((failed) => known.has(failed))
			.slice(0, settings.failures)
			.map((failed) => active.find((item) => id(item) === failed) as EvalCase);
		rotating = rotate(
			active.filter((item) => !item.core && !(settings.skipSlow && item.slow)),
			settings.rotating,
			slot,
			settings.coverageFloor,
		);
	}

	const chosen = new Map<string, EvalCase>();
	for (const item of [...core, ...newCases, ...failures, ...rotating]) chosen.set(id(item), item);
	const suites = new Set([...chosen.values()].map((item) => item.suite));
	const files = [
		...(Object.keys(SUITE_FILES) as Suite[]).filter((suite) => suites.has(suite)).map((suite) => SUITE_FILES[suite]),
		EXTRA_FILES.smoke,
		...(tier === "full" ? [EXTRA_FILES.extensions] : []),
	];
	// Each case is listed under the first reason it was chosen: core, then new, then recent failure, then rotation.
	const labelled = new Set(core.map(id));
	const label = (items: EvalCase[]) =>
		items.map(id).filter((value) => {
			if (labelled.has(value)) return false;
			labelled.add(value);
			return true;
		});
	return {
		schemaVersion: 1,
		tier,
		seed,
		slot,
		date,
		cases: [...chosen.keys()],
		core: core.map(id),
		newCases: label(newCases),
		recentFailures: label(failures),
		rotating: label(rotating),
		files,
	};
}

/** Cases whose latest run (newest run directory first) was wrong, for the same model, most recent first. */
export function readRecentFailures(evalDirectory: string, model: string | undefined): string[] {
	if (!existsSync(evalDirectory)) return [];
	const directories = readdirSync(evalDirectory)
		.filter((name) => existsSync(join(evalDirectory, name, "runs.jsonl")))
		.sort()
		.reverse()
		.slice(0, HISTORY_RUNS);
	const latest = new Map<string, boolean>();
	for (const directory of directories) {
		for (const record of parseRuns(readFileSync(join(evalDirectory, directory, "runs.jsonl"), "utf8")).reverse()) {
			if (model !== undefined && record.usage?.model !== model) continue;
			const found = caseOfHarness(record.harness);
			if (!found) continue;
			const key = caseId(found.suite, found.id);
			if (!latest.has(key)) latest.set(key, isCorrect(record));
		}
	}
	return [...latest].filter(([, correct]) => !correct).map(([key]) => key);
}

/** Cases nobody has reviewed in REVIEW_DAYS. A review is a person confirming the case still tests something real. */
export function staleCases(date: string, cases: readonly EvalCase[] = evalCases): string[] {
	return cases
		.filter((item) => !item.retired)
		.filter((item) => daysBetween(item.reviewed ?? item.added ?? REGISTRY_CREATED, date) > REVIEW_DAYS)
		.map((item) => caseId(item.suite, item.id));
}

/** Throws when a manifest names a case the registry no longer has, so a replay never silently runs fewer cases. */
export function validateManifest(manifest: Manifest, cases: readonly EvalCase[] = evalCases): void {
	const known = new Set(cases.map((item) => caseId(item.suite, item.id)));
	const missing = manifest.cases.filter((item) => !known.has(item));
	if (missing.length > 0) throw new Error(`Manifest names cases the registry does not have: ${missing.join(", ")}`);
}

/** The selection the runner passed to this vitest process, or undefined when running ad hoc (every case runs). */
function selectedIds(): Set<string> | undefined {
	const path = process.env.THEOSES_EVAL_MANIFEST?.trim();
	if (!path) return undefined;
	const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
	return new Set(manifest.cases);
}

/** The tasks of a suite that this run selected. */
export function selectedTasks<T extends { id: string }>(suite: Suite, tasks: readonly T[]): T[] {
	const ids = selectedIds();
	return ids ? tasks.filter((task) => ids.has(caseId(suite, task.id))) : [...tasks];
}
