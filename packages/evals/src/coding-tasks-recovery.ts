import type { CodingTask } from "./coding-grader.ts";

// Each task is set up so the obvious first edit is rejected by the edit tool: the line to change appears more than
// once, the prompt quotes the code with different whitespace than the file has, or the prompt describes a value the
// file no longer holds. The agent has to read the tool's error (or the file) and edit again. Graded on the end state
// like every coding task, so the score shows whether recovery worked, not whether the first edit landed.
export const recoveryTasks: CodingTask[] = [
	{
		id: "edit-duplicate-line",
		prompt:
			"In pricing.mjs, `applyDiscount` should round the discounted price down (Math.floor) instead of rounding to the nearest cent. `applyTax` and `applyShipping` must keep rounding to the nearest cent. Do not edit the tests.",
		files: {
			"pricing.mjs": `export function applyDiscount(amount, percent) {
	const discounted = amount * (1 - percent / 100);
	return Math.round(discounted * 100) / 100;
}

export function applyTax(amount, percent) {
	const taxed = amount * (1 + percent / 100);
	return Math.round(taxed * 100) / 100;
}

export function applyShipping(amount, flat) {
	const total = amount + flat;
	return Math.round(total * 100) / 100;
}
`,
			"pricing.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { applyDiscount, applyTax, applyShipping } from "./pricing.mjs";

test("discount rounds down to the cent", () => {
	assert.equal(applyDiscount(10, 33.335), 6.66);
});

test("tax and shipping still round to the nearest cent", () => {
	assert.equal(applyTax(10, 33.335), 13.33);
	assert.equal(applyTax(10, 33.356), 13.34);
	assert.equal(applyShipping(1.005, 0.0004), 1.01);
});
`,
		},
		protectedFiles: ["pricing.test.mjs"],
		solution: {
			"pricing.mjs": `export function applyDiscount(amount, percent) {
	const discounted = amount * (1 - percent / 100);
	return Math.floor(discounted * 100) / 100;
}

export function applyTax(amount, percent) {
	const taxed = amount * (1 + percent / 100);
	return Math.round(taxed * 100) / 100;
}

export function applyShipping(amount, flat) {
	const total = amount + flat;
	return Math.round(total * 100) / 100;
}
`,
		},
	},
	{
		id: "edit-quoted-with-spaces",
		prompt:
			'`dequeue` in queue.mjs returns undefined on an empty queue. Make it throw `new Error("queue empty")` instead. The current method reads:\n\n```\n  dequeue() {\n    return this.items.shift();\n  }\n```\n\nDo not edit the tests.',
		files: {
			"queue.mjs": `export class Queue {
	constructor() {
		this.items = [];
	}

	enqueue(item) {
		this.items.push(item);
	}

	dequeue() {
		return this.items.shift();
	}

	get size() {
		return this.items.length;
	}
}
`,
			"queue.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { Queue } from "./queue.mjs";

test("dequeue returns items in order", () => {
	const q = new Queue();
	q.enqueue("a");
	q.enqueue("b");
	assert.equal(q.dequeue(), "a");
	assert.equal(q.dequeue(), "b");
	assert.equal(q.size, 0);
});

test("dequeue on an empty queue throws", () => {
	assert.throws(() => new Queue().dequeue(), /queue empty/);
});
`,
		},
		protectedFiles: ["queue.test.mjs"],
		solution: {
			"queue.mjs": `export class Queue {
	constructor() {
		this.items = [];
	}

	enqueue(item) {
		this.items.push(item);
	}

	dequeue() {
		if (this.items.length === 0) throw new Error("queue empty");
		return this.items.shift();
	}

	get size() {
		return this.items.length;
	}
}
`,
		},
	},
	{
		id: "edit-stale-description",
		prompt:
			"In retry.mjs, change `const MAX_RETRIES = 3;` to 10, so a failing call is attempted 10 times before giving up. Do not edit the tests.",
		files: {
			"retry.mjs": `// Tuned down during the outage; see the incident notes.
const MAX_RETRIES = 5;

export async function withRetry(fn) {
	let lastError;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}
`,
			"retry.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "./retry.mjs";

test("gives up after 10 attempts", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(async () => {
			calls++;
			throw new Error("down");
		}),
		/down/,
	);
	assert.equal(calls, 10);
});

test("returns the first success", async () => {
	let calls = 0;
	const value = await withRetry(async () => {
		calls++;
		if (calls < 4) throw new Error("flaky");
		return "ok";
	});
	assert.equal(value, "ok");
	assert.equal(calls, 4);
});
`,
		},
		protectedFiles: ["retry.test.mjs"],
		solution: {
			"retry.mjs": `// Tuned down during the outage; see the incident notes.
const MAX_RETRIES = 10;

export async function withRetry(fn) {
	let lastError;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}
`,
		},
	},
];
