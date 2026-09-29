import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CodingTask, gradeWorkspace, writeFiles } from "../src/coding-grader.ts";
import { easyTasks } from "../src/coding-tasks-easy.ts";
import { hardTasks } from "../src/coding-tasks-hard.ts";
import { recoveryTasks } from "../src/coding-tasks-recovery.ts";

const tasks: CodingTask[] = [...easyTasks, ...hardTasks, ...recoveryTasks];

// A bad fixture must not be mistaken for a bad agent: every task has to fail as seeded and pass with its
// reference solution, and the solution must leave protected files alone.
describe("coding task fixtures", () => {
	it("has unique task ids", () => {
		const ids = tasks.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it.each(tasks.map((task) => [task.id, task] as const))(
		"%s fails as seeded and passes with its solution",
		(_id, task) => {
			const cwd = mkdtempSync(join(tmpdir(), `coding-task-${task.id}-`));
			try {
				writeFiles(cwd, task.files);
				expect(gradeWorkspace(cwd, task).testsPassed).toBe(false);

				writeFiles(cwd, task.solution);
				const solved = gradeWorkspace(cwd, task);
				expect(solved.testOutput).toBeTypeOf("string");
				expect(solved.testsPassed, solved.testOutput).toBe(true);
				expect(solved.protectedIntact).toBe(true);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
