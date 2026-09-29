import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingOutput } from "./coding-grader.ts";

// A replay task starts the agent at the parent of a real fix in this repository, describes the bug the way its issue
// did, and grades with the regression test that fix added. The agent never sees that test: it is written into the
// workspace after the run. The workspace is a `git archive` of the parent (no history to read the fix from), with the
// repo's installed node_modules linked in so the test runs without another install.
export type ReplayTask = {
	id: string;
	/** The commit that fixed the bug; the task starts at its parent. */
	fixCommit: string;
	/** The bug as a report: what goes wrong and where, not how it was fixed. */
	prompt: string;
	/** Repo-relative path of the regression test that commit added or changed. */
	testFile: string;
};

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function git(args: string[]): { ok: boolean; stdout: string } {
	const result = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
	return { ok: result.status === 0, stdout: result.stdout };
}

/** False in a shallow clone that does not have the commit; the eval workflow fetches full history. */
export function hasCommit(commit: string): boolean {
	return git(["cat-file", "-e", `${commit}^{commit}`]).ok;
}

/** The repo-relative files a commit changed, split into tests and everything else. */
export function changedFiles(commit: string): { tests: string[]; source: string[] } {
	const files = git(["show", "--name-only", "--format=", commit]).stdout.split("\n").filter(Boolean);
	const isTest = (file: string) => /(^|\/)test\//.test(file);
	const isDoc = (file: string) => /\.md$/.test(file);
	return { tests: files.filter(isTest), source: files.filter((file) => !isTest(file) && !isDoc(file)) };
}

/** Writes the tree of `<fixCommit>~1` into `cwd` and links the installed dependencies. */
export function seedReplayWorkspace(cwd: string, task: ReplayTask): void {
	mkdirSync(cwd, { recursive: true });
	const extract = spawnSync("sh", [
		"-c",
		'git -C "$0" archive "$1" | tar -x -C "$2"',
		REPO_ROOT,
		`${task.fixCommit}~1`,
		cwd,
	]);
	if (extract.status !== 0) throw new Error(`Could not extract ${task.fixCommit}~1: ${extract.stderr}`);
	linkDependencies(cwd);
}

function linkDependencies(cwd: string): void {
	const link = (relative: string) => {
		const source = join(REPO_ROOT, relative);
		if (existsSync(source)) symlinkSync(source, join(cwd, relative));
	};
	link("node_modules");
	for (const name of readdirSync(join(REPO_ROOT, "packages"))) link(join("packages", name, "node_modules"));
}

/** Overlays the fix commit's non-test files onto `cwd`; only the fixture test uses it, to prove a task is solvable. */
export function applyReferenceFix(cwd: string, task: ReplayTask): void {
	for (const file of changedFiles(task.fixCommit).source) {
		const target = join(cwd, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, git(["show", `${task.fixCommit}:${file}`]).stdout);
	}
}

/** Writes the regression test into the workspace and runs it. */
export function gradeReplay(cwd: string, task: ReplayTask): CodingOutput {
	const target = join(cwd, task.testFile);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, git(["show", `${task.fixCommit}:${task.testFile}`]).stdout);
	const [packages, name, ...rest] = task.testFile.split("/");
	const result = spawnSync("node", [join(REPO_ROOT, "node_modules/vitest/dist/cli.js"), "--run", rest.join("/")], {
		cwd: join(cwd, packages, name),
		encoding: "utf8",
		timeout: 180_000,
	});
	return {
		testsPassed: result.status === 0,
		protectedIntact: true,
		testOutput: `${result.stdout}${result.stderr}`.slice(-2000),
	};
}
