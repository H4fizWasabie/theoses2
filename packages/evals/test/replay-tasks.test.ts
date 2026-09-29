import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReferenceFix, changedFiles, gradeReplay, hasCommit, seedReplayWorkspace } from "../src/replay-grader.ts";
import { replayTasks } from "../src/replay-tasks.ts";

// A bad replay must not be mistaken for a bad agent: at the parent commit the regression test has to fail, and with
// the fix's source files on top it has to pass. Needs the fix commits, so it skips in a shallow clone.
describe("replay task fixtures", () => {
	it("has unique task ids", () => {
		const ids = replayTasks.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
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
