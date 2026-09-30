import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseId, type EvalCase, evalCases } from "../src/case-registry.ts";
import {
	interleaveByCategory,
	readRecentFailures,
	rotate,
	selectCases,
	slotFromSeed,
	staleCases,
	validateManifest,
} from "../src/selection.ts";

const pool: EvalCase[] = [
	{ suite: "coding", id: "a1", category: "bugfix" },
	{ suite: "coding", id: "a2", category: "bugfix" },
	{ suite: "coding", id: "a3", category: "bugfix" },
	{ suite: "coding", id: "a4", category: "bugfix" },
	{ suite: "coding", id: "a5", category: "bugfix" },
	{ suite: "coding", id: "a6", category: "bugfix" },
	{ suite: "coding", id: "b1", category: "refactor" },
	{ suite: "coding", id: "c1", category: "replay" },
	{ suite: "coding", id: "c2", category: "replay" },
];
const ids = (items: EvalCase[]) => items.map((item) => item.id);

describe("interleaveByCategory", () => {
	it("alternates categories so a window of consecutive picks spans them", () => {
		expect(ids(interleaveByCategory(pool)).slice(0, 6)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
	});
});

describe("rotate", () => {
	it("is deterministic for a slot", () => {
		expect(ids(rotate(pool, 4, 7, true))).toEqual(ids(rotate(pool, 4, 7, true)));
	});

	it("reaches every case within ceil(pool / count) consecutive slots", () => {
		for (const count of [2, 3, 4, 8]) {
			for (const startSlot of [0, 5, 19_000]) {
				const reached = new Set<string>();
				for (let slot = startSlot; slot < startSlot + Math.ceil(pool.length / count); slot += 1) {
					for (const item of rotate(pool, count, slot, false)) reached.add(item.id);
				}
				expect([...reached].sort(), `count ${count} from slot ${startSlot}`).toEqual(ids(pool).sort());
			}
		}
	});

	it("with the coverage floor, samples every category in every run even when the window would miss one", () => {
		for (let slot = 0; slot < 30; slot += 1) {
			const categories = new Set(rotate(pool, 3, slot, true).map((item) => item.category));
			expect([...categories].sort(), `slot ${slot}`).toEqual(["bugfix", "refactor", "replay"]);
		}
	});

	it("returns everything when asked for more than the pool", () => {
		expect(rotate(pool, 100, 3, false)).toHaveLength(pool.length);
	});
});

describe("slotFromSeed", () => {
	it("uses the day number when there is no seed, so the rotation moves daily", () => {
		const today = slotFromSeed("2026-09-30", "2026-09-30");
		expect(slotFromSeed("2026-10-01", "2026-10-01")).toBe(today + 1);
	});

	it("takes a number as the slot and hashes any other text the same way every time", () => {
		expect(slotFromSeed("42", "2026-09-30")).toBe(42);
		expect(slotFromSeed("release-candidate", "2026-09-30")).toBe(slotFromSeed("release-candidate", "2026-01-01"));
		expect(slotFromSeed("release-candidate", "2026-09-30")).not.toBe(slotFromSeed("other", "2026-09-30"));
	});

	it("rejects a date that is not ISO", () => {
		expect(() => selectCases({ tier: "smoke", date: "yesterday" })).toThrow("Not an ISO date");
	});
});

describe("selectCases on the real registry", () => {
	const date = "2026-09-30";

	it("smoke is the core cases plus two rotating ones, and always runs the smoke eval", () => {
		const manifest = selectCases({ tier: "smoke", date });
		const core = evalCases.filter((item) => item.core).length;
		expect(manifest.core).toHaveLength(core);
		expect(manifest.rotating).toHaveLength(2);
		expect(manifest.cases).toHaveLength(core + 2);
		expect(manifest.files).toContain("src/smoke.eval.ts");
		expect(manifest.files).not.toContain("src/extensions.eval.ts");
	});

	it("smoke never rotates in a slow case, whatever the slot", () => {
		const slow = new Set(evalCases.filter((item) => item.slow).map((item) => caseId(item.suite, item.id)));
		for (let slot = 0; slot < 60; slot += 1) {
			const manifest = selectCases({ tier: "smoke", date, seed: String(slot) });
			expect(
				manifest.rotating.filter((id) => slow.has(id)),
				`slot ${slot}`,
			).toEqual([]);
		}
	});

	it("smoke still re-runs a slow case that failed recently", () => {
		const manifest = selectCases({ tier: "smoke", date, recentFailures: ["coding-replay/auto-resume-timer-leak"] });
		expect(manifest.recentFailures).toEqual(["coding-replay/auto-resume-timer-leak"]);
	});

	it("rotate covers every category with a non-core case", () => {
		for (let day = 0; day < 20; day += 1) {
			const manifest = selectCases({ tier: "rotate", date, seed: String(day) });
			const categories = new Set(
				manifest.rotating.map((id) => evalCases.find((item) => caseId(item.suite, item.id) === id)?.category),
			);
			expect([...categories].sort(), `slot ${day}`).toEqual(
				[...new Set(evalCases.map((item) => item.category))].sort(),
			);
		}
	});

	it("rotate reaches every non-core case within a few days, so none is ignored for weeks", () => {
		const reached = new Set<string>();
		for (let day = 0; day < 4; day += 1) {
			for (const id of selectCases({ tier: "rotate", date, seed: String(day) }).cases) reached.add(id);
		}
		expect(reached.size).toBe(evalCases.length);
	});

	it("full is every active case plus the extension eval", () => {
		const manifest = selectCases({ tier: "full", date });
		expect(manifest.cases).toHaveLength(evalCases.length);
		expect(manifest.files).toEqual(expect.arrayContaining(["src/extensions.eval.ts", "src/smoke.eval.ts"]));
	});

	it("gives the same manifest for the same inputs and a different one for another seed", () => {
		expect(selectCases({ tier: "rotate", date, seed: "s1" })).toEqual(
			selectCases({ tier: "rotate", date, seed: "s1" }),
		);
		expect(selectCases({ tier: "rotate", date, seed: "s1" }).rotating).not.toEqual(
			selectCases({ tier: "rotate", date, seed: "s2" }).rotating,
		);
	});

	it("lists only the suites that have a selected case, so vitest is never given a file with no tests", () => {
		const manifest = selectCases({ tier: "smoke", date });
		const suites = new Set(manifest.cases.map((id) => id.split("/")[0]));
		expect(manifest.files.filter((file) => file.startsWith("src/coding")).length).toBe(suites.size);
	});
});

describe("selectCases with recent failures, new cases and retirement", () => {
	const registry: EvalCase[] = [
		{ suite: "coding", id: "core", category: "bugfix", core: true },
		...ids(pool).map((id): EvalCase => ({ suite: "coding", id, category: "bugfix" })),
		{ suite: "coding", id: "fresh", category: "refactor", added: "2026-09-28" },
		{ suite: "coding", id: "old", category: "refactor", added: "2026-01-01" },
		{ suite: "coding", id: "gone", category: "refactor", retired: "covered by another case" },
	];

	it("adds recent failures ahead of rotation, capped per tier, and ignores unknown or core ids", () => {
		const failures = ["coding/a6", "coding/nope", "coding/core", "coding/a5", "coding/a4", "coding/a3", "coding/a2"];
		const smoke = selectCases({ tier: "smoke", date: "2026-09-30", cases: registry, recentFailures: failures });
		expect(smoke.recentFailures).toEqual(["coding/a6", "coding/a5", "coding/a4"]);
		const rotateRun = selectCases({ tier: "rotate", date: "2026-09-30", cases: registry, recentFailures: failures });
		expect(rotateRun.recentFailures).toEqual(["coding/a6", "coding/a5", "coding/a4", "coding/a3", "coding/a2"]);
	});

	it("labels a case once, under its first reason", () => {
		const manifest = selectCases({
			tier: "rotate",
			date: "2026-09-30",
			cases: registry,
			recentFailures: ["coding/a1"],
		});
		const labelled = [...manifest.core, ...manifest.newCases, ...manifest.recentFailures, ...manifest.rotating];
		expect(new Set(labelled).size).toBe(labelled.length);
		expect(new Set(manifest.cases)).toEqual(new Set(labelled));
	});

	it("always runs a case added in the last 14 days in rotate, and not an old one by that rule", () => {
		const manifest = selectCases({ tier: "rotate", date: "2026-09-30", cases: registry, seed: "0" });
		expect(manifest.cases).toContain("coding/fresh");
		expect(manifest.newCases).toEqual(["coding/fresh"]);
	});

	it("never runs a retired case in any tier", () => {
		for (const tier of ["smoke", "rotate", "full"] as const) {
			expect(selectCases({ tier, date: "2026-09-30", cases: registry }).cases).not.toContain("coding/gone");
		}
	});
});

describe("readRecentFailures", () => {
	const record = (harness: string, status: string, model = "m") =>
		JSON.stringify({ harness, test: { status }, usage: { model } });

	it("reports cases whose latest run was wrong, for this model only, newest first", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-history-"));
		try {
			const write = (name: string, lines: string[]) => {
				mkdirSync(join(directory, name));
				writeFileSync(join(directory, name, "runs.jsonl"), `${lines.join("\n")}\n`);
			};
			write("2026-09-28T00-00-00.000Z_a", [
				record("coding-hard-sibling-sort-bug", "failed"),
				record("coding-fix-off-by-one", "failed"),
				record("coding-rename-across-files", "failed", "other-model"),
			]);
			write("2026-09-29T00-00-00.000Z_b", [
				record("coding-fix-off-by-one", "passed"),
				record("coding-hard-navigate-many-files", "failed"),
				record("plan-on-sibling-sort-bug", "failed"),
			]);
			expect(readRecentFailures(directory, "m")).toEqual([
				"coding-hard/navigate-many-files",
				"coding-hard/sibling-sort-bug",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("returns nothing when there is no history", () => {
		expect(readRecentFailures(join(tmpdir(), "does-not-exist-eval-history"), "m")).toEqual([]);
	});
});

describe("staleCases and validateManifest", () => {
	it("lists cases unreviewed for over 180 days", () => {
		const cases: EvalCase[] = [
			{ suite: "coding", id: "stale", category: "bugfix" },
			{ suite: "coding", id: "reviewed", category: "bugfix", reviewed: "2027-03-01" },
		];
		expect(staleCases("2027-03-30", cases)).toEqual(["coding/stale"]);
		expect(staleCases("2026-10-30", cases)).toEqual([]);
	});

	it("refuses to replay a manifest that names a case that no longer exists", () => {
		const manifest = selectCases({ tier: "smoke", date: "2026-09-30" });
		expect(() => validateManifest(manifest)).not.toThrow();
		expect(() => validateManifest({ ...manifest, cases: [...manifest.cases, "coding/deleted"] })).toThrow(
			"coding/deleted",
		);
	});
});
