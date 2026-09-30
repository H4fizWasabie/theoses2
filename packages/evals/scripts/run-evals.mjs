import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSummary, readRunRecords, summarizeRuns } from "../src/run-summary.ts";
import { readRecentFailures, selectCases, TIER_NAMES, validateManifest } from "../src/selection.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = process.env.THEOSES_EVAL_ARTIFACT_DIR
	? resolve(packageRoot, process.env.THEOSES_EVAL_ARTIFACT_DIR)
	: resolve(
			packageRoot,
			".eval",
			`${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`,
		);
const args = process.argv.slice(2);
let provider;
let model;
let hasCliModelSelection = false;
const vitestArgs = [];
// Case selection: --tier smoke|rotate|full, --seed, --date (YYYY-MM-DD), --replay <manifest.json>. See README.
const selectionOptions = {};
const SELECTION_FLAGS = ["--tier", "--seed", "--date", "--replay"];

for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	const selectionFlag = SELECTION_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
	if (selectionFlag) {
		const value = arg === selectionFlag ? args[index + 1] : arg.slice(selectionFlag.length + 1);
		if (!value || (arg === selectionFlag && value.startsWith("-"))) {
			console.error(`Missing value for ${selectionFlag}`);
			process.exit(1);
		}
		selectionOptions[selectionFlag.slice(2)] = value;
		if (arg === selectionFlag) index += 1;
		continue;
	}
	if (arg === "--provider" || arg === "--model") {
		const value = args[index + 1];
		if (!value || value.startsWith("-")) {
			console.error(`Missing value for ${arg}`);
			process.exit(1);
		}
		if (arg === "--provider") provider = value;
		else model = value;
		hasCliModelSelection = true;
		index += 1;
		continue;
	}
	if (arg.startsWith("--provider=")) {
		provider = arg.slice("--provider=".length);
		hasCliModelSelection = true;
		continue;
	}
	if (arg.startsWith("--model=")) {
		model = arg.slice("--model=".length);
		hasCliModelSelection = true;
		continue;
	}
	vitestArgs.push(arg);
}

provider = provider?.trim() || undefined;
model = model?.trim() || undefined;
if (hasCliModelSelection) {
	if (!provider || !model) {
		console.error("CLI model selection requires both --provider and --model.");
		process.exit(1);
	}
} else {
	provider = process.env.THEOSES_PROVIDER?.trim() || undefined;
	model = process.env.THEOSES_MODEL?.trim() || undefined;
	if (Boolean(provider) !== Boolean(model)) {
		console.error("Default model selection requires both THEOSES_PROVIDER and THEOSES_MODEL.");
		process.exit(1);
	}
}

const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestCliPath = resolve(dirname(vitestPackagePath), "vitest.mjs");

mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
console.error(`[eval] default-model=${provider && model ? `${provider}/${model}` : "none"}`);
console.error(`[eval] artifacts=${artifactDirectory}`);
const childEnvironment = {
	...process.env,
	THEOSES_EVAL_ARTIFACT_DIR: artifactDirectory,
};

// Explicit eval files (`npm run eval -- src/extensions.eval.ts`) run ad hoc, every case in them. Otherwise the run is a
// tier (smoke unless told otherwise) or an exact replay, and a manifest of the chosen cases is written to the artifacts.
const hasFileArgument = vitestArgs.some((arg) => arg.endsWith(".eval.ts") || arg.startsWith("src/"));
const { replay, tier, seed, date } = selectionOptions;
if (replay && (tier || seed || date)) {
	console.error("--replay reruns a recorded selection; it cannot be combined with --tier, --seed or --date.");
	process.exit(1);
}
if ((tier || replay) && hasFileArgument) {
	console.error("--tier and --replay choose the eval files themselves; drop the explicit file arguments.");
	process.exit(1);
}
if (tier && !TIER_NAMES.includes(tier)) {
	console.error(`Unknown tier "${tier}"; expected one of ${TIER_NAMES.join(", ")}.`);
	process.exit(1);
}
let manifest;
if (replay) {
	manifest = { ...JSON.parse(readFileSync(resolve(replay), "utf8")), replayOf: resolve(replay) };
	validateManifest(manifest);
} else if (tier || !hasFileArgument) {
	manifest = selectCases({
		tier: tier ?? "smoke",
		date: date ?? new Date().toISOString().slice(0, 10),
		seed,
		recentFailures: readRecentFailures(resolve(packageRoot, ".eval"), model),
	});
}
if (manifest) {
	const manifestPath = join(artifactDirectory, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
	childEnvironment.THEOSES_EVAL_MANIFEST = manifestPath;
	vitestArgs.unshift(...manifest.files);
	console.error(
		`[eval] tier=${manifest.tier} seed=${manifest.seed} slot=${manifest.slot} cases=${manifest.cases.length}` +
			` (core ${manifest.core.length}, new ${manifest.newCases.length}, recent failures ${manifest.recentFailures.length}, rotating ${manifest.rotating.length})`,
	);
	console.error(`[eval] replay this exact selection: --replay ${manifestPath}`);
}
if (provider && model) {
	childEnvironment.THEOSES_PROVIDER = provider;
	childEnvironment.THEOSES_MODEL = model;
} else {
	delete childEnvironment.THEOSES_PROVIDER;
	delete childEnvironment.THEOSES_MODEL;
}
const result = spawnSync(
	process.execPath,
	[vitestCliPath, "run", "--config", "vitest.config.ts", ...vitestArgs],
	{
		cwd: packageRoot,
		stdio: "inherit",
		env: childEnvironment,
	},
);

if (result.error) {
	throw result.error;
}

if (manifest) {
	console.error(`\n${formatSummary(summarizeRuns(readRunRecords(artifactDirectory)))}`);
}

process.exit(result.status ?? 1);
