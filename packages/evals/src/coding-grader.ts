import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A coding task seeds a tiny Node project, gives the agent one prompt, then grades the workspace by running
// `node --test`. Test files are protected: editing them to force a pass scores 0.
export type CodingTask = {
	id: string;
	prompt: string;
	files: Record<string, string>;
	/** Files the agent must not modify. */
	protectedFiles: string[];
	/** Grader-owned tests written after the run, so the agent never sees them (siblings, edge cases). */
	hiddenTests?: Record<string, string>;
	/** Files overlaid on `files` to form a correct solution. Only test/coding-tasks.test.ts uses it. */
	solution: Record<string, string>;
};

export type CodingOutput = { testsPassed: boolean; protectedIntact: boolean; testOutput: string };

export function writeFiles(cwd: string, files: Record<string, string>): void {
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(cwd, relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

export function gradeWorkspace(cwd: string, task: CodingTask): CodingOutput {
	const protectedIntact = task.protectedFiles.every((file) => {
		try {
			return readFileSync(join(cwd, file), "utf8") === task.files[file];
		} catch {
			return false;
		}
	});
	writeFiles(cwd, task.hiddenTests ?? {});
	const result = spawnSync("node", ["--test"], { cwd, encoding: "utf8", timeout: 120_000 });
	return {
		testsPassed: result.status === 0,
		protectedIntact,
		testOutput: `${result.stdout}${result.stderr}`.slice(-2000),
	};
}
