/**
 * Verification Evidence: what a run changed and which runtime checks it ran after its last change. A verify item
 * is satisfied only by its declared check command, run after the last source change (and after the item was
 * declared); a "tested/verified" claim needs the same. The Task Plan, its guard and the claim check all ask
 * here, so they judge one run with the same cwd and the same protected paths (files the run edited, which a
 * write never counts as scratch for).
 *
 * `tool-runs.ts` is the shell-command parser behind this: what one command reads, changes and executes.
 */

import type { AgentMessage } from "theoses-agent-core";
import { FILE_TOOLS, isCheckCommand, runChangesFiles, type ToolRun, toolRuns } from "./tool-runs.ts";

export interface RunEvidence {
	/** Tool results in execution order. */
	readonly runs: readonly ToolRun[];
	/** The run changed files (or tried to, through a shell command). */
	readonly changed: boolean;
	readonly lastChange: ToolRun | undefined;
	/** The run called `task_plan`. */
	readonly usedPlanTool: boolean;
	/** The run did anything the plan governs: changed files or called `task_plan`. */
	readonly touchedPlan: boolean;
	/** Id of the latest tool result; a verify item declared now cannot be satisfied by anything up to it. */
	readonly lastRunId: string | undefined;
	/**
	 * The latest check command after the last change, and after the run with id `after` when given, matching
	 * `command` when given. Passing or not: a failed one is the evidence that the check fails.
	 */
	check(options?: { command?: string; after?: string }): ToolRun | undefined;
	/** Whether `command` counts as a runtime check here: it executes behavior, not just syntax, lint, help or reads. */
	isRuntimeCheck(command: string): boolean;
}

/** Models retype commands with different spacing or line breaks; the command is what binds evidence, not its whitespace. */
function sameCommand(a: string, b: string): boolean {
	const normalized = (command: string) => command.trim().replace(/\s+/g, " ");
	return normalized(a) === normalized(b);
}

export function readRunEvidence(runMessages: AgentMessage[], cwd: string): RunEvidence {
	const runs = toolRuns(runMessages);
	const protectedPaths = runs.filter((run) => FILE_TOOLS.has(run.name) && run.path).map((run) => run.path as string);
	const changes = runs.map((run) => runChangesFiles(run, cwd, protectedPaths));
	const lastChangeIndex = changes.lastIndexOf(true);
	const isCheck = (run: ToolRun) => isCheckCommand(run, cwd, protectedPaths);
	const usedPlanTool = runs.some((run) => run.name === "task_plan");

	return {
		runs,
		changed: lastChangeIndex >= 0,
		lastChange: runs[lastChangeIndex],
		usedPlanTool,
		touchedPlan: usedPlanTool || lastChangeIndex >= 0,
		lastRunId: runs.at(-1)?.id,
		check({ command, after } = {}) {
			const afterIndex = after === undefined ? -1 : runs.findIndex((run) => run.id === after);
			return runs
				.slice(Math.max(lastChangeIndex, afterIndex) + 1)
				.filter(
					(run) =>
						isCheck(run) &&
						(command === undefined || (run.command !== undefined && sameCommand(run.command, command))),
				)
				.pop();
		},
		isRuntimeCheck(command) {
			return isCheck({ id: "", name: "bash", command, path: undefined, output: "", isError: false });
		},
	};
}
