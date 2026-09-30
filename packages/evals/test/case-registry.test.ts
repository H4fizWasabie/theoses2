import { describe, expect, it } from "vitest";
import { caseId, caseOfHarness, evalCases, SUITE_FILES } from "../src/case-registry.ts";
import { easyTasks } from "../src/coding-tasks-easy.ts";
import { hardTasks } from "../src/coding-tasks-hard.ts";
import { recoveryTasks } from "../src/coding-tasks-recovery.ts";
import { replayTasks } from "../src/replay-tasks.ts";

const defined = [
	...easyTasks.map((task) => caseId("coding", task.id)),
	...hardTasks.map((task) => caseId("coding-hard", task.id)),
	...recoveryTasks.map((task) => caseId("coding-recovery", task.id)),
	...replayTasks.map((task) => caseId("coding-replay", task.id)),
];
const registered = evalCases.map((item) => caseId(item.suite, item.id));

describe("case registry", () => {
	it("has a row for every task and no row without a task, so a new task cannot be left out of every tier", () => {
		expect([...registered].sort()).toEqual([...defined].sort());
	});

	it("has unique rows", () => {
		expect(new Set(registered).size).toBe(registered.length);
	});

	it("maps every suite to an eval file", () => {
		for (const item of evalCases) expect(SUITE_FILES[item.suite]).toMatch(/^src\/coding.*\.eval\.ts$/);
	});

	it("pins a core case in each category that has a case fast enough for every run", () => {
		const categories = new Set(evalCases.map((item) => item.category));
		for (const category of categories) {
			const ofCategory = evalCases.filter((item) => item.category === category && !item.retired);
			expect(
				ofCategory.some((item) => item.core),
				category,
			).toBe(ofCategory.some((item) => !item.slow));
		}
	});

	it("never makes a slow case core", () => {
		expect(evalCases.filter((item) => item.core && item.slow)).toEqual([]);
	});

	it("finds a case from its harness name", () => {
		expect(caseOfHarness("coding-hard-sibling-sort-bug")).toMatchObject({
			suite: "coding-hard",
			id: "sibling-sort-bug",
		});
		expect(caseOfHarness("coding-fix-off-by-one")).toMatchObject({ suite: "coding", id: "fix-off-by-one" });
		expect(caseOfHarness("plan-on-sibling-sort-bug")).toBeUndefined();
	});
});
