import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyReferenceFix,
	changedFiles,
	gradeReplay,
	hasCommit,
	linkDependencies,
	seedReplayWorkspace,
} from "../src/replay-grader.ts";
import { replayTasks } from "../src/replay-tasks.ts";

describe("linkDependencies", () => {
	it("links installed node_modules but skips a package the extracted commit does not have", () => {
		const root = mkdtempSync(join(tmpdir(), "link-root-"));
		const cwd = mkdtempSync(join(tmpdir(), "link-cwd-"));
		try {
			for (const dir of ["node_modules", "packages/old/node_modules", "packages/newer/node_modules"]) {
				mkdirSync(join(root, dir), { recursive: true });
			}
			// The extracted commit has `old` but predates `newer`.
			mkdirSync(join(cwd, "packages/old"), { recursive: true });

			linkDependencies(cwd, root);

			expect(existsSync(join(cwd, "node_modules"))).toBe(true);
			expect(existsSync(join(cwd, "packages/old/node_modules"))).toBe(true);
			expect(existsSync(join(cwd, "packages/newer"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// A bad replay must not be mistaken for a bad agent: at the parent commit the regression test has to fail, and with
// the fix's source files on top it has to pass. Needs the fix commits, so it skips in a shallow clone.
describe("replay task fixtures", () => {
	it("has unique task ids", () => {
		const ids = replayTasks.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("seeds a workspace without the repo's own agent configuration, which would load extensions into the eval session", () => {
		const task = replayTasks[0];
		if (!hasCommit(task.fixCommit)) return;
		const cwd = mkdtempSync(join(tmpdir(), "replay-config-"));
		try {
			seedReplayWorkspace(cwd, task);
			for (const dir of [".theoses", ".agents", ".codex"]) expect(existsSync(join(cwd, dir))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.each(replayTasks.map((task) => [task.id, task] as const))(
		"%s fails at the parent commit and passes with the reference fix",
		(_id, task) => {
			if (!hasCommit(task.fixCommit)) return;
			expect(changedFiles(task.fixCommit).tests).toContain(task.testFile);
			const cwd = mkdtempSync(join(tmpdir(), `replay-${task.id}-`));
			try {
				seedReplayWorkspace(cwd, task);
				expect(gradeReplay(cwd, task).testsPassed).toBe(false);

				applyReferenceFix(cwd, task);
				const solved = gradeReplay(cwd, task);
				expect(solved.testsPassed, solved.testOutput).toBe(true);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		180_000,
	);
});
