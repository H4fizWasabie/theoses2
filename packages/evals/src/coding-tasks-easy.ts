import type { CodingTask } from "./coding-grader.ts";

export const easyTasks: CodingTask[] = [
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
		solution: {
			"range.mjs": `export function sumTo(n) {
	let total = 0;
	for (let i = 1; i <= n; i++) total += i;
	return total;
}
`,
		},
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
		solution: {
			"users.mjs": `export function fetchUser(id) {
	return { id, name: "user-" + id };
}
`,
			"greet.mjs": `import { fetchUser } from "./users.mjs";
export function greet(id) {
	return "Hello, " + fetchUser(id).name;
}
`,
			"report.mjs": `import { fetchUser } from "./users.mjs";
export function report(ids) {
	return ids.map((id) => fetchUser(id).name).join(",");
}
`,
		},
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
		solution: {
			"slugify.mjs": `export function slugify(text) {
	return text
		.normalize("NFD")
		.replace(/[\\u0300-\\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
`,
		},
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
		solution: {
			"duration.mjs": `const UNITS = { s: 1, m: 60, h: 3600 };

export function parseDuration(text) {
	const match = /^(\\d+)([smh])$/.exec(text);
	if (!match) throw new RangeError("bad duration: " + text);
	return Number(match[1]) * UNITS[match[2]];
}

export function totalSeconds(parts) {
	return parts.map(parseDuration).reduce((a, b) => a + b, 0);
}
`,
		},
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
		solution: {
			"join.mjs": `export function join(items, { separator = "," } = {}) {
	return items.join(separator);
}
`,
		},
	},
];
