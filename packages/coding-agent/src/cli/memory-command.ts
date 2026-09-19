import { writeFileSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { type DuplicateGroup, type MemoryDedupPlan, planMemoryDedup } from "../core/memory-dedup.ts";
import { FileMemoryStore } from "../core/memory-store.ts";

const DEFAULT_GROUPS_SHOWN = 10;

function getMemoryCommandUsage(): string {
	return `${APP_NAME} memory dedup-report [--json <file>] [--limit <n>]`;
}

function printMemoryCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${getMemoryCommandUsage()}

Inspect the long-term memory store.

Commands:
  dedup-report   Dry run: find memory nodes that restate a fact the store already has, and nodes that
                 other nodes have superseded. Reads the store and reports; it never changes anything.

Options:
  --json <file>  Write the full report (every group, every superseded node) to <file>
  --limit <n>    How many of the largest duplicate groups to print (default ${DEFAULT_GROUPS_SHOWN})
`);
}

function shorten(text: string, length = 100): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
}

function printGroup(group: DuplicateGroup): void {
	console.log(`  ${chalk.green("keep")}    ${group.keep.at.slice(0, 10)}  ${shorten(group.keep.subject)}`);
	for (const removal of group.remove.slice(0, 4)) {
		const note = removal.adds.length > 0 ? chalk.yellow(`  [adds: ${removal.adds.slice(0, 4).join(", ")}]`) : "";
		console.log(`  ${chalk.dim("remove")}  ${removal.at.slice(0, 10)}  ${shorten(removal.subject)}${note}`);
	}
	if (group.remove.length > 4) console.log(`  ${chalk.dim(`... and ${group.remove.length - 4} more`)}`);
}

export function printDedupReport(plan: MemoryDedupPlan, groupsShown: number): void {
	const { totals } = plan;
	console.log(chalk.bold(`Memory store: ${plan.nodeCount} nodes`));
	console.log(
		`  duplicate nodes (restate a fact stored earlier): ${totals.duplicateNodes} in ${plan.duplicateGroups.length} groups`,
	);
	console.log(`    of which add words the kept node lacks, review these: ${totals.duplicatesAddingWords}`);
	console.log(`  superseded nodes (hidden from recall, still stored):   ${totals.supersededNodes}`);
	console.log(`  removable in total (a node can be both):               ${totals.removableNodes}`);
	if (plan.duplicateGroups.length > 0 && groupsShown > 0) {
		console.log(
			chalk.bold(`\nLargest duplicate groups (showing ${Math.min(groupsShown, plan.duplicateGroups.length)}):`),
		);
		for (const group of plan.duplicateGroups.slice(0, groupsShown)) {
			printGroup(group);
			console.log("");
		}
	}
	console.log(chalk.dim("Dry run: nothing was changed."));
}

export async function handleMemoryCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "memory") return false;
	const sub = args[1];

	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		printMemoryCommandHelp();
		return true;
	}

	if (sub !== "dedup-report") {
		console.error(chalk.red(`Unknown memory command "${sub}". Usage: ${getMemoryCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	let jsonPath: string | undefined;
	let limit = DEFAULT_GROUPS_SHOWN;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") {
			jsonPath = args[++index];
			if (!jsonPath) {
				console.error(chalk.red("--json needs a file path"));
				process.exitCode = 1;
				return true;
			}
		} else if (arg === "--limit") {
			limit = Number.parseInt(args[++index] ?? "", 10);
			if (!Number.isInteger(limit) || limit < 0) {
				console.error(chalk.red("--limit needs a non-negative number"));
				process.exitCode = 1;
				return true;
			}
		} else {
			console.error(chalk.red(`Unknown option "${arg}". Usage: ${getMemoryCommandUsage()}`));
			process.exitCode = 1;
			return true;
		}
	}

	const plan = planMemoryDedup(new FileMemoryStore().listNodes());
	printDedupReport(plan, limit);
	if (jsonPath) {
		writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
		console.log(`Full report written to ${jsonPath}`);
	}
	return true;
}
