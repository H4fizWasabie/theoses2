import type { CodingTask } from "./coding-grader.ts";

// Harder than the easy set: siblings the visible test does not cover, misleading errors, navigation
// through many files, a spec with edge cases, and a bug report with no test at all. Hidden tests grade
// what the visible ones cannot.

const TAX_REGIONS = [
	"ab",
	"bc",
	"mb",
	"nb",
	"nl",
	"ns",
	"nt",
	"nu",
	"on",
	"pe",
	"qc",
	"sk",
	"yt",
	"wa",
	"or",
	"ca",
	"nv",
	"az",
	"co",
	"tx",
	"ny",
	"nj",
	"fl",
	"il",
];

function taxFiles(fixed: boolean): Record<string, string> {
	const files: Record<string, string> = {};
	TAX_REGIONS.forEach((code, i) => {
		if (code === "qc") {
			files["tax/qc.mjs"] = `// Quebec: GST 5% plus QST 9.975%.
export const GST = 0.05;
export const QST = 0.09975;
export function tax(amount) {
	return ${fixed ? "amount * (GST + QST)" : "amount * GST"};
}
`;
		} else {
			const rate = code === "on" ? 0.13 : (5 + (i % 9)) / 100;
			files[`tax/${code}.mjs`] = `export const RATE = ${rate};
export function tax(amount) {
	return amount * RATE;
}
`;
		}
	});
	files["tax/index.mjs"] = `${TAX_REGIONS.map((c) => `import * as ${c} from "./${c}.mjs";`).join("\n")}

export const REGIONS = { ${TAX_REGIONS.join(", ")} };
`;
	return files;
}

export const hardTasks: CodingTask[] = [
	{
		id: "sibling-sort-bug",
		prompt:
			"The median test in stats.test.mjs fails. Find the bug and fix it, including anywhere else in the project where the same mistake occurs. Do not edit the tests.",
		files: {
			"stats.mjs": `export function median(nums) {
	const sorted = [...nums].sort();
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
`,
			"report.mjs": `export function topN(nums, n) {
	return [...nums].sort().reverse().slice(0, n);
}
`,
			"invoice.mjs": `export function sortedAmounts(lines) {
	return lines.map((line) => line.amount).sort();
}
`,
			"stats.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { median } from "./stats.mjs";

test("median", () => {
	assert.equal(median([10, 9, 100]), 10);
	assert.equal(median([1, 2, 3, 4]), 2.5);
	assert.equal(median([5]), 5);
});
`,
		},
		protectedFiles: ["stats.test.mjs"],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { topN } from "./report.mjs";
import { sortedAmounts } from "./invoice.mjs";

test("topN sorts numerically", () => {
	assert.deepEqual(topN([10, 9, 100, 1], 2), [100, 10]);
});

test("sortedAmounts sorts numerically", () => {
	assert.deepEqual(sortedAmounts([{ amount: 10 }, { amount: 9 }, { amount: 100 }]), [9, 10, 100]);
});
`,
		},
		solution: {
			"stats.mjs": `export function median(nums) {
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
`,
			"report.mjs": `export function topN(nums, n) {
	return [...nums].sort((a, b) => a - b).reverse().slice(0, n);
}
`,
			"invoice.mjs": `export function sortedAmounts(lines) {
	return lines.map((line) => line.amount).sort((a, b) => a - b);
}
`,
		},
	},
	{
		id: "misleading-error-shallow-merge",
		prompt:
			"server.test.mjs fails with a TypeError thrown from server.mjs. Find the real cause and fix it. Do not edit the tests.",
		files: {
			"config.mjs": `const DEFAULTS = {
	server: { host: "localhost", port: 8080 },
	db: { host: "localhost", name: "app" },
};

export function loadConfig(overrides = {}) {
	return { ...DEFAULTS, ...overrides };
}
`,
			"server.mjs": `export function listenAddress(config) {
	return config.server.host + ":" + config.server.port.toString();
}
`,
			"server.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";
import { listenAddress } from "./server.mjs";

test("defaults", () => {
	assert.equal(listenAddress(loadConfig()), "localhost:8080");
});

test("a partial override keeps the default port", () => {
	assert.equal(listenAddress(loadConfig({ server: { host: "0.0.0.0" } })), "0.0.0.0:8080");
});
`,
		},
		protectedFiles: ["server.test.mjs"],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";

test("nested db override keeps sibling defaults", () => {
	assert.deepEqual(loadConfig({ db: { name: "x" } }).db, { host: "localhost", name: "x" });
});

test("a returned config never aliases the defaults", () => {
	const first = loadConfig();
	first.server.port = 1;
	assert.equal(loadConfig().server.port, 8080);
});
`,
		},
		solution: {
			"config.mjs": `const DEFAULTS = {
	server: { host: "localhost", port: 8080 },
	db: { host: "localhost", name: "app" },
};

function isObject(value) {
	return typeof value === "object" && value !== null;
}

function merge(base, extra) {
	const out = {};
	for (const key of Object.keys(base)) out[key] = isObject(base[key]) ? merge(base[key], {}) : base[key];
	for (const key of Object.keys(extra)) {
		out[key] = isObject(extra[key]) && isObject(out[key]) ? merge(out[key], extra[key]) : extra[key];
	}
	return out;
}

export function loadConfig(overrides = {}) {
	return merge(DEFAULTS, overrides);
}
`,
		},
	},
	{
		id: "navigate-many-files",
		prompt:
			"Customers in Quebec are being undercharged sales tax at checkout. Find the cause and fix it. Do not edit the tests.",
		files: {
			...taxFiles(false),
			"checkout.mjs": `import { REGIONS } from "./tax/index.mjs";

export function computeTax(code, amount) {
	const region = REGIONS[code.toLowerCase()];
	if (!region) throw new RangeError("unknown region: " + code);
	return Math.round(region.tax(amount) * 1000) / 1000;
}
`,
			"checkout.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { computeTax } from "./checkout.mjs";

test("Ontario", () => {
	assert.equal(computeTax("ON", 100), 13);
});

test("Quebec charges GST and QST", () => {
	assert.equal(computeTax("QC", 100), 14.975);
});

test("unknown region", () => {
	assert.throws(() => computeTax("ZZ", 1), RangeError);
});
`,
		},
		protectedFiles: ["checkout.test.mjs"],
		solution: { "tax/qc.mjs": taxFiles(true)["tax/qc.mjs"] },
	},
	{
		id: "circular-import",
		prompt: "Running `node --test` fails at import time. Diagnose and fix it. Do not edit the tests.",
		files: {
			"base.mjs": `import { LEVELS } from "./logger.mjs";

export const DEFAULT_LEVEL = LEVELS[1];
`,
			"logger.mjs": `import { DEFAULT_LEVEL } from "./base.mjs";

export const LEVELS = ["debug", "info", "warn"];

export function createLogger(level = DEFAULT_LEVEL) {
	return { level };
}
`,
			"logger.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, LEVELS } from "./logger.mjs";
import { DEFAULT_LEVEL } from "./base.mjs";

test("logger defaults to info", () => {
	assert.equal(createLogger().level, "info");
	assert.equal(DEFAULT_LEVEL, "info");
	assert.equal(LEVELS.length, 3);
	assert.equal(createLogger("warn").level, "warn");
});
`,
		},
		protectedFiles: ["logger.test.mjs"],
		solution: {
			"levels.mjs": `export const LEVELS = ["debug", "info", "warn"];
`,
			"base.mjs": `import { LEVELS } from "./levels.mjs";

export const DEFAULT_LEVEL = LEVELS[1];
`,
			"logger.mjs": `import { DEFAULT_LEVEL } from "./base.mjs";

export { LEVELS } from "./levels.mjs";

export function createLogger(level = DEFAULT_LEVEL) {
	return { level };
}
`,
		},
	},
	{
		id: "async-dedupe-race",
		prompt:
			"The loader test fails: concurrent loads of the same key hit the backend twice. Fix createLoader so concurrent loads share one fetch. Do not edit the tests.",
		files: {
			"loader.mjs": `export function createLoader(fetchFn) {
	const cache = new Map();
	return async function load(key) {
		if (cache.has(key)) return cache.get(key);
		const value = await fetchFn(key);
		cache.set(key, value);
		return value;
	};
}
`,
			"loader.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./loader.mjs";

test("concurrent loads share one fetch", async () => {
	let calls = 0;
	const load = createLoader(async (key) => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return key + "!";
	});
	const [a, b] = await Promise.all([load("x"), load("x")]);
	assert.equal(a, "x!");
	assert.equal(b, "x!");
	assert.equal(calls, 1);
});

test("a finished load is cached", async () => {
	let calls = 0;
	const load = createLoader(async (key) => {
		calls++;
		return key;
	});
	await load("k");
	await load("k");
	assert.equal(calls, 1);
});
`,
		},
		protectedFiles: ["loader.test.mjs"],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./loader.mjs";

test("a failed load is not cached", async () => {
	let calls = 0;
	const load = createLoader(async () => {
		calls++;
		if (calls === 1) throw new Error("boom");
		return "ok";
	});
	await assert.rejects(load("k"), /boom/);
	assert.equal(await load("k"), "ok");
	assert.equal(calls, 2);
});
`,
		},
		solution: {
			"loader.mjs": `export function createLoader(fetchFn) {
	const cache = new Map();
	return function load(key) {
		if (!cache.has(key)) {
			const pending = Promise.resolve().then(() => fetchFn(key));
			cache.set(key, pending);
			pending.catch(() => cache.delete(key));
		}
		return cache.get(key);
	};
}
`,
		},
	},
	{
		id: "quadratic-performance",
		prompt:
			"`uniqueSorted` is far too slow on large inputs, so the performance test fails. Make it fast without changing its output. Do not edit the tests.",
		files: {
			"unique.mjs": `export function uniqueSorted(nums) {
	const out = [];
	for (const n of nums) {
		if (!out.includes(n)) out.push(n);
	}
	return out.sort((a, b) => a - b);
}
`,
			"unique.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { uniqueSorted } from "./unique.mjs";

test("small input", () => {
	assert.deepEqual(uniqueSorted([3, 1, 3, 2, 1]), [1, 2, 3]);
	assert.deepEqual(uniqueSorted([]), []);
});

test("large input finishes quickly", () => {
	const input = Array.from({ length: 120000 }, (_, i) => i % 60000);
	const start = performance.now();
	const result = uniqueSorted(input);
	const elapsed = performance.now() - start;
	assert.equal(result.length, 60000);
	assert.equal(result[0], 0);
	assert.equal(result[59999], 59999);
	assert.ok(elapsed < 300, "took " + Math.round(elapsed) + "ms");
});
`,
		},
		protectedFiles: ["unique.test.mjs"],
		solution: {
			"unique.mjs": `export function uniqueSorted(nums) {
	return [...new Set(nums)].sort((a, b) => a - b);
}
`,
		},
	},
	{
		id: "shared-mutable-state",
		prompt:
			"The tests in options.test.mjs pass one at a time but fail when the file runs as a whole. Fix the source, not the tests.",
		files: {
			"options.mjs": `const defaults = { retries: 3, verbose: false };

export function withDefaults(opts = {}) {
	return Object.assign(defaults, opts);
}
`,
			"options.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { withDefaults } from "./options.mjs";

test("an override applies", () => {
	assert.equal(withDefaults({ retries: 10 }).retries, 10);
});

test("a later call gets the defaults", () => {
	assert.equal(withDefaults().retries, 3);
	assert.equal(withDefaults().verbose, false);
});
`,
		},
		protectedFiles: ["options.test.mjs"],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { withDefaults } from "./options.mjs";

test("mutating a result does not change later results", () => {
	const first = withDefaults();
	first.retries = 99;
	assert.equal(withDefaults().retries, 3);
});
`,
		},
		solution: {
			"options.mjs": `const defaults = { retries: 3, verbose: false };

export function withDefaults(opts = {}) {
	return { ...defaults, ...opts };
}
`,
		},
	},
	{
		id: "rename-with-lookalikes",
		prompt:
			"Rename the function `parse` exported by records.mjs to `parseRecord`, and update everything that uses it. Other things named `parse` (csv.mjs, JSON.parse) are unrelated: leave them alone. Do not edit the tests.",
		files: {
			"records.mjs": `export function parse(line) {
	const [id, name] = line.split(",");
	return { id: Number(id), name };
}
`,
			"loader.mjs": `import { parse } from "./records.mjs";

export function loadAll(text) {
	return text.split("\\n").filter(Boolean).map((line) => parse(line));
}
`,
			"csv.mjs": `export function parse(text) {
	return text.split("\\n").map((row) => row.split(","));
}
`,
			"config.mjs": `export function readConfig(json) {
	return JSON.parse(json);
}
`,
			"api.mjs": `import { parse as parseCsv } from "./csv.mjs";
import { parse } from "./records.mjs";

export function importRecord(line) {
	return parse(line);
}

export function importGrid(text) {
	return parseCsv(text);
}
`,
			"rename.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as records from "./records.mjs";
import * as csv from "./csv.mjs";
import { loadAll } from "./loader.mjs";
import { readConfig } from "./config.mjs";
import { importRecord, importGrid } from "./api.mjs";

test("records.parse is renamed", () => {
	assert.equal(typeof records.parseRecord, "function");
	assert.equal(records.parse, undefined);
	assert.deepEqual(records.parseRecord("1,ann"), { id: 1, name: "ann" });
});

test("callers still work", () => {
	assert.deepEqual(loadAll("1,a\\n2,b"), [
		{ id: 1, name: "a" },
		{ id: 2, name: "b" },
	]);
	assert.deepEqual(importRecord("3,c"), { id: 3, name: "c" });
});

test("look-alikes are untouched", () => {
	assert.equal(typeof csv.parse, "function");
	assert.deepEqual(importGrid("a,b\\nc,d"), [["a", "b"], ["c", "d"]]);
	assert.deepEqual(readConfig('{"a":1}'), { a: 1 });
	assert.match(readFileSync(new URL("./config.mjs", import.meta.url), "utf8"), /JSON\\.parse/);
});
`,
		},
		protectedFiles: ["rename.test.mjs"],
		solution: {
			"records.mjs": `export function parseRecord(line) {
	const [id, name] = line.split(",");
	return { id: Number(id), name };
}
`,
			"loader.mjs": `import { parseRecord } from "./records.mjs";

export function loadAll(text) {
	return text.split("\\n").filter(Boolean).map((line) => parseRecord(line));
}
`,
			"api.mjs": `import { parse as parseCsv } from "./csv.mjs";
import { parseRecord } from "./records.mjs";

export function importRecord(line) {
	return parseRecord(line);
}

export function importGrid(text) {
	return parseCsv(text);
}
`,
		},
	},
	{
		id: "change-signature-all-callers",
		prompt:
			"Change `formatPrice` in format.mjs to take an options object as its second argument: `formatPrice(amount, { currency, showSymbol })`, both optional. Update every caller so behaviour stays the same. Do not edit the tests.",
		files: {
			"format.mjs": `const SYMBOLS = { USD: "$", EUR: "€" };

export function formatPrice(amount, currency = "USD", showSymbol = true) {
	const digits = amount.toFixed(2);
	return showSymbol ? (SYMBOLS[currency] ?? currency + " ") + digits : digits;
}
`,
			"cart.mjs": `import { formatPrice } from "./format.mjs";

export function cartTotalLabel(items) {
	return formatPrice(items.reduce((sum, item) => sum + item.price, 0), "USD");
}
`,
			"receipt.mjs": `import { formatPrice } from "./format.mjs";

export function receiptLine(line) {
	return formatPrice(line.amount, line.currency, false);
}
`,
			"email.mjs": `import { formatPrice } from "./format.mjs";

export function emailTotal(total) {
	return formatPrice(total, "EUR", true);
}
`,
			"invoice.mjs": `import { formatPrice } from "./format.mjs";

export function invoiceTotal(amounts) {
	return formatPrice(amounts.reduce((a, b) => a + b, 0));
}
`,
			"admin.mjs": `import { formatPrice } from "./format.mjs";

export function adminPrice(amount, currency, showSymbol) {
	return formatPrice(amount, currency, showSymbol);
}
`,
			"format.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "./format.mjs";
import { cartTotalLabel } from "./cart.mjs";
import { receiptLine } from "./receipt.mjs";
import { emailTotal } from "./email.mjs";
import { invoiceTotal } from "./invoice.mjs";
import { adminPrice } from "./admin.mjs";

test("options object", () => {
	assert.equal(formatPrice(5), "$5.00");
	assert.equal(formatPrice(5, { currency: "EUR" }), "€5.00");
	assert.equal(formatPrice(5, { showSymbol: false }), "5.00");
	assert.equal(formatPrice(5, { currency: "GBP" }), "GBP 5.00");
});

test("callers keep their behaviour", () => {
	assert.equal(cartTotalLabel([{ price: 2 }, { price: 3 }]), "$5.00");
	assert.equal(receiptLine({ amount: 4, currency: "EUR" }), "4.00");
	assert.equal(emailTotal(7), "€7.00");
	assert.equal(invoiceTotal([1, 2]), "$3.00");
	assert.equal(adminPrice(9, "EUR", true), "€9.00");
	assert.equal(adminPrice(9), "$9.00");
	assert.equal(adminPrice(9, "EUR", false), "9.00");
});
`,
		},
		protectedFiles: ["format.test.mjs"],
		solution: {
			"format.mjs": `const SYMBOLS = { USD: "$", EUR: "€" };

export function formatPrice(amount, { currency = "USD", showSymbol = true } = {}) {
	const digits = amount.toFixed(2);
	return showSymbol ? (SYMBOLS[currency] ?? currency + " ") + digits : digits;
}
`,
			"cart.mjs": `import { formatPrice } from "./format.mjs";

export function cartTotalLabel(items) {
	return formatPrice(items.reduce((sum, item) => sum + item.price, 0), { currency: "USD" });
}
`,
			"receipt.mjs": `import { formatPrice } from "./format.mjs";

export function receiptLine(line) {
	return formatPrice(line.amount, { currency: line.currency, showSymbol: false });
}
`,
			"email.mjs": `import { formatPrice } from "./format.mjs";

export function emailTotal(total) {
	return formatPrice(total, { currency: "EUR", showSymbol: true });
}
`,
			"admin.mjs": `import { formatPrice } from "./format.mjs";

export function adminPrice(amount, currency, showSymbol) {
	return formatPrice(amount, { currency, showSymbol });
}
`,
		},
	},
	{
		id: "bug-report-no-tests",
		prompt: `A user reported a bug in paginate.mjs and there is no test for it yet. Fix it.

paginate(items, page, size) is meant to use 1-based pages: page 1 is the first \`size\` items, the last page may be partial, and a page past the end is an empty array. It must throw a RangeError when page or size is not a positive integer. Today page 1 skips the first \`size\` items, and bad arguments are not rejected.`,
		files: {
			"paginate.mjs": `export function paginate(items, page, size) {
	const start = page * size;
	return items.slice(start, start + size);
}
`,
		},
		protectedFiles: [],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "./paginate.mjs";

const items = [1, 2, 3, 4, 5];

test("pages are 1-based", () => {
	assert.deepEqual(paginate(items, 1, 2), [1, 2]);
	assert.deepEqual(paginate(items, 2, 2), [3, 4]);
});

test("the last page may be partial", () => {
	assert.deepEqual(paginate(items, 3, 2), [5]);
});

test("a page past the end is empty", () => {
	assert.deepEqual(paginate(items, 4, 2), []);
});

test("bad arguments throw RangeError", () => {
	assert.throws(() => paginate(items, 0, 2), RangeError);
	assert.throws(() => paginate(items, 1, 0), RangeError);
	assert.throws(() => paginate(items, 1.5, 2), RangeError);
	assert.throws(() => paginate(items, -1, 2), RangeError);
});
`,
		},
		solution: {
			"paginate.mjs": `export function paginate(items, page, size) {
	if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1) {
		throw new RangeError("page and size must be positive integers");
	}
	const start = (page - 1) * size;
	return items.slice(start, start + size);
}
`,
		},
	},
	{
		id: "implement-from-spec",
		prompt:
			"Implement `parseArgs` in args.mjs as described in SPEC.md. args.test.mjs covers the basics; the spec has more cases than the tests. Do not edit the tests.",
		files: {
			"SPEC.md": `# parseArgs(argv)

Takes an array of strings and returns \`{ flags, positionals }\`.

- \`--name=value\` and \`--name value\` both set \`flags.name = "value"\`. A flag followed by another flag, or by nothing, is the boolean \`true\`.
- \`--name=\` sets \`flags.name = ""\`.
- \`-abc\` sets \`flags.a\`, \`flags.b\` and \`flags.c\` to \`true\`.
- A flag given more than once becomes an array of its values in order: \`--tag a --tag b\` gives \`tag: ["a", "b"]\`.
- \`--no-color\` sets \`flags.color = false\`.
- Everything after a bare \`--\` is positional and is not parsed.
- Any other argument is positional.
`,
			"args.mjs": `export function parseArgs(argv) {
	throw new Error("not implemented");
}
`,
			"args.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.mjs";

test("long flags", () => {
	assert.deepEqual(parseArgs(["--name=x"]).flags, { name: "x" });
	assert.deepEqual(parseArgs(["--name", "x"]).flags, { name: "x" });
});

test("short bundle", () => {
	assert.deepEqual(parseArgs(["-ab"]).flags, { a: true, b: true });
});

test("positionals", () => {
	assert.deepEqual(parseArgs(["file.txt"]).positionals, ["file.txt"]);
});
`,
		},
		protectedFiles: ["args.test.mjs", "SPEC.md"],
		hiddenTests: {
			"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.mjs";

test("repeated flags become an array", () => {
	assert.deepEqual(parseArgs(["--tag", "a", "--tag", "b"]).flags, { tag: ["a", "b"] });
});

test("--no-x sets false", () => {
	assert.deepEqual(parseArgs(["--no-color"]).flags, { color: false });
});

test("a bare -- ends parsing", () => {
	assert.deepEqual(parseArgs(["x", "--", "--y", "-z"]), { flags: {}, positionals: ["x", "--y", "-z"] });
});

test("a flag before another flag is boolean", () => {
	assert.deepEqual(parseArgs(["--verbose", "--name", "x"]).flags, { verbose: true, name: "x" });
});

test("an empty value is kept", () => {
	assert.equal(parseArgs(["--out="]).flags.out, "");
});

test("mixed", () => {
	assert.deepEqual(parseArgs(["build", "-v", "--out=dist", "src"]), {
		flags: { v: true, out: "dist" },
		positionals: ["build", "src"],
	});
});
`,
		},
		solution: {
			"args.mjs": `export function parseArgs(argv) {
	const flags = {};
	const positionals = [];
	const set = (name, value) => {
		flags[name] = name in flags ? [].concat(flags[name], value) : value;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				set(arg.slice(2, eq), arg.slice(eq + 1));
				continue;
			}
			const name = arg.slice(2);
			if (name.startsWith("no-")) {
				set(name.slice(3), false);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				set(name, next);
				i++;
			} else {
				set(name, true);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (const letter of arg.slice(1)) set(letter, true);
		} else {
			positionals.push(arg);
		}
	}
	return { flags, positionals };
}
`,
		},
	},
];

// Callers the visible test does not cover: changing what a function returns breaks the files that use it, and only the
// hidden tests exercise them. The prompt names the function and the new shape, not the callers.
hardTasks.push({
	id: "dependents-return-shape",
	prompt:
		"parseEntry in parse.mjs should return an object with `key` and `value` fields instead of a two-element array. Make that change. Do not edit the tests.",
	files: {
		"parse.mjs": `export function parseEntry(line) {
	const index = line.indexOf("=");
	return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}
`,
		"settings.mjs": `import { parseEntry } from "./parse.mjs";

export function loadSettings(text) {
	const settings = {};
	for (const line of text.split("\\n").filter(Boolean)) {
		const [key, value] = parseEntry(line);
		settings[key] = value;
	}
	return settings;
}
`,
		"env.mjs": `import { parseEntry } from "./parse.mjs";

export function envLines(text) {
	return text
		.split("\\n")
		.filter(Boolean)
		.map((line) => {
			const [key, value] = parseEntry(line);
			return key.toUpperCase() + "=" + value;
		});
}
`,
		"parse.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { parseEntry } from "./parse.mjs";

test("parseEntry returns named fields", () => {
	assert.deepEqual(parseEntry("name = theo"), { key: "name", value: "theo" });
	assert.deepEqual(parseEntry("a=b=c"), { key: "a", value: "b=c" });
});
`,
	},
	protectedFiles: ["parse.test.mjs"],
	hiddenTests: {
		"hidden.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "./settings.mjs";
import { envLines } from "./env.mjs";

test("loadSettings still reads every entry", () => {
	assert.deepEqual(loadSettings("a=1\\nb = 2"), { a: "1", b: "2" });
});

test("envLines still formats every entry", () => {
	assert.deepEqual(envLines("a=1\\nb = 2"), ["A=1", "B=2"]);
});
`,
	},
	solution: {
		"parse.mjs": `export function parseEntry(line) {
	const index = line.indexOf("=");
	return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}
`,
		"settings.mjs": `import { parseEntry } from "./parse.mjs";

export function loadSettings(text) {
	const settings = {};
	for (const line of text.split("\\n").filter(Boolean)) {
		const { key, value } = parseEntry(line);
		settings[key] = value;
	}
	return settings;
}
`,
		"env.mjs": `import { parseEntry } from "./parse.mjs";

export function envLines(text) {
	return text
		.split("\\n")
		.filter(Boolean)
		.map((line) => {
			const { key, value } = parseEntry(line);
			return key.toUpperCase() + "=" + value;
		});
}
`,
	},
});

// The same task worded as the first version was: the prompt names only the failing median test, and the hidden tests
// still require the two sibling files to be fixed. No model tried (GLM 5.3 flash, gpt-6-luna, claude-sonnet-5.5) passes
// it, so it stays as a tracked signal of stopping at the reported symptom, not as a pass/fail bar for the agent.
const siblingSortBug = hardTasks.find((task) => task.id === "sibling-sort-bug");
if (!siblingSortBug) throw new Error("sibling-sort-bug task is missing");
hardTasks.push({
	...siblingSortBug,
	id: "sibling-sort-bug-unstated",
	prompt: "The median test in stats.test.mjs fails. Find the bug and fix it. Do not edit the tests.",
});
