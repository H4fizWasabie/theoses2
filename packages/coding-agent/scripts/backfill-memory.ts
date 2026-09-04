#!/usr/bin/env node
/**
 * Backfills semantic + episodic memory from historical session-log files, using the same
 * consolidation extraction pipeline as the live keyword/turn-ceiling trigger.
 *
 * Usage:
 *   node scripts/backfill-memory.ts <path-to-session.jsonl>
 *   node scripts/backfill-memory.ts <path-to-directory-of-session-logs>
 *
 * Requires a configured model runtime (agentDir/models.json + auth) with OpenRouter access to
 * deepseek/deepseek-v4-flash-0731, same as the live consolidation pass.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { backfillFromSessionLog } from "../src/core/memory-consolidation.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function main(): Promise<void> {
	const target = process.argv[2];
	if (!target) {
		console.error("Usage: node scripts/backfill-memory.ts <session-log-file-or-directory>");
		process.exit(1);
	}

	const resolvedTarget = resolve(target);
	if (!existsSync(resolvedTarget)) {
		console.error(`Not found: ${resolvedTarget}`);
		process.exit(1);
	}

	const files = statSync(resolvedTarget).isDirectory()
		? readdirSync(resolvedTarget)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => join(resolvedTarget, name))
		: [resolvedTarget];

	if (files.length === 0) {
		console.log("No .jsonl session-log files found.");
		return;
	}

	const modelRuntime = await ModelRuntime.create();

	for (const file of files) {
		console.log(`Backfilling ${file}...`);
		try {
			await backfillFromSessionLog(file, { cwd: process.cwd(), modelRuntime });
			console.log(`  done`);
		} catch (error) {
			console.error(`  failed: ${error instanceof Error ? error.message : error}`);
		}
	}
}

await main();
