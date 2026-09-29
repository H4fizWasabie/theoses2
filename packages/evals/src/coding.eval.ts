import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJudge, describeEval } from "vitest-evals";
import { createTheosesCodingAgentHarness, type TheosesCodingAgentInput } from "./theoses-harness.ts";

// Each task seeds a tiny Node project, gives the agent one prompt, then grades the workspace by running
// `node --test`. Test files are protected: editing them to force a pass scores 0. Add tasks to grow the baseline.
// Above the package-wide 120s so a slow agent run is scored on its result, not killed mid-fix.
const TASK_TIMEOUT_MS = 300_000;

type CodingTask = {
	id: string;
	prompt: string;
	files: Record<string, string>;
	/** Files the agent must not modify. */
	protectedFiles: string[];
};

type CodingOutput = { testsPassed: boolean; protectedIntact: boolean; testOutput: string };

const tasks: CodingTask[] = [
	{
		id: "fix-off-by-one",
		prompt: "The tests in this project fail. Find the bug and fix it. Do not edit the tests.",
		files: {
			"range.mjs": `export function sumTo(n) {
	let total = 0;
	for (let i = 1; i < n; i++) total += i;
	return total;
}
`,
			"range.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { sumTo } from "./range.mjs";

test("sumTo includes n", () => {
	assert.equal(sumTo(4), 10);
	assert.equal(sumTo(1), 1);
	assert.equal(sumTo(0), 0);
});
`,
		},
		protectedFiles: ["range.test.mjs"],
	},
	{
		id: "rename-across-files",
		prompt:
			"Rename the function `getUser` to `fetchUser` everywhere in this project (definition and all call sites). Do not edit the tests.",
		files: {
			"users.mjs": `export function getUser(id) {
	return { id, name: "user-" + id };
}
`,
			"greet.mjs": `import { getUser } from "./users.mjs";
export function greet(id) {
	return "Hello, " + getUser(id).name;
}
`,
			"report.mjs": `import { getUser } from "./users.mjs";
export function report(ids) {
	return ids.map((id) => getUser(id).name).join(",");
}
`,
			"app.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import * as users from "./users.mjs";
import { greet } from "./greet.mjs";
import { report } from "./report.mjs";

test("renamed", () => {
	assert.equal(typeof users.fetchUser, "function");
	assert.equal(users.getUser, undefined);
	assert.equal(greet(2), "Hello, user-2");
	assert.equal(report([1, 2]), "user-1,user-2");
});
`,
		},
		protectedFiles: ["app.test.mjs"],
	},
	{
		id: "implement-from-tests",
		prompt: "Implement `slugify` in slugify.mjs so that the tests pass. Do not edit the tests.",
		files: {
			"slugify.mjs": `export function slugify(text) {
	throw new Error("not implemented");
}
`,
			"slugify.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slugify.mjs";

test("slugify", () => {
	assert.equal(slugify("Hello World"), "hello-world");
	assert.equal(slugify("  Multiple   spaces  "), "multiple-spaces");
	assert.equal(slugify("Crème Brûlée!"), "creme-brulee");
	assert.equal(slugify("--already--slug--"), "already-slug");
	assert.equal(slugify(""), "");
});
`,
		},
		protectedFiles: ["slugify.test.mjs"],
	},
	{
		id: "fix-from-stack-trace",
		prompt: "Running `node --test` fails. Diagnose and fix the source code. Do not edit the tests.",
		files: {
			"duration.mjs": `const UNITS = { s: 1, m: 60, h: 3600 };

export function parseDuration(text) {
	const match = /^(\\d+)([smh])$/.exec(text);
	return Number(match[1]) * UNITS[match[2]];
}

export function totalSeconds(parts) {
	return parts.map(parseDuration).reduce((a, b) => a + b);
}
`,
			"duration.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, totalSeconds } from "./duration.mjs";

test("parses", () => {
	assert.equal(parseDuration("90s"), 90);
	assert.equal(parseDuration("2m"), 120);
});

test("totals, including an empty list", () => {
	assert.equal(totalSeconds(["1m", "30s"]), 90);
	assert.equal(totalSeconds([]), 0);
});

test("rejects garbage with a TypeError-free RangeError", () => {
	assert.throws(() => parseDuration("abc"), RangeError);
});
`,
		},
		protectedFiles: ["duration.test.mjs"],
	},
	{
		id: "add-option-keep-behavior",
		prompt:
			"Add an optional second parameter `{ separator }` to `join` in join.mjs (default `,`) so the tests pass. Existing behavior must not change. Do not edit the tests.",
		files: {
			"join.mjs": `export function join(items) {
	return items.join(",");
}
`,
			"join.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { join } from "./join.mjs";

test("default separator", () => {
	assert.equal(join(["a", "b"]), "a,b");
	assert.equal(join(["a", "b"], {}), "a,b");
});

test("custom separator", () => {
	assert.equal(join(["a", "b"], { separator: " | " }), "a | b");
});
`,
		},
		protectedFiles: ["join.test.mjs"],
	},
];

function runNodeTests(cwd: string): { passed: boolean; output: string } {
	const result = spawnSync("node", ["--test"], { cwd, encoding: "utf8", timeout: 60_000 });
	return { passed: result.status === 0, output: `${result.stdout}${result.stderr}`.slice(-2000) };
}

const CodingJudge = createJudge<TheosesCodingAgentInput, CodingOutput>("CodingJudge", ({ output }) => {
	const failures: string[] = [];
	if (!output.testsPassed) failures.push("tests fail");
	if (!output.protectedIntact) failures.push("protected files modified");
	return {
		score: failures.length === 0 ? 1 : 0,
		metadata: { rationale: failures.length === 0 ? "Tests pass." : `${failures.join("; ")}\n${output.testOutput}` },
	};
});

for (const task of tasks) {
	const harness = createTheosesCodingAgentHarness({
		name: `coding-${task.id}`,
		files: task.files,
		// Production runs at "max" (settings.json defaultThinkingLevel); baseline the same.
		thinkingLevel: "max",
		// The deployed agent sets taskPlan.enabled=false; the library default is true, which adds
		// task-plan and independent plan-review round trips that pushed a trivial rename past the timeout.
		settings: { taskPlan: { enabled: false } },
		output: ({ session }): CodingOutput => {
			const cwd = session.sessionManager.getCwd();
			const protectedIntact = task.protectedFiles.every(
				(file) => readFileSync(join(cwd, file), "utf8") === task.files[file],
			);
			const { passed, output } = runNodeTests(cwd);
			return { testsPassed: passed, protectedIntact, testOutput: output };
		},
	});

	describeEval(`Theoses coding: ${task.id}`, { harness, judges: [CodingJudge], judgeThreshold: null }, (it) => {
		it(
			"solves the task",
			async ({ run }) => {
				await run(task.prompt);
			},
			TASK_TIMEOUT_MS,
		);
	});
}
