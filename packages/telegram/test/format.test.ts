import { describe, expect, it } from "vitest";
import { containsPipeTable } from "../src/format.ts";

describe("containsPipeTable", () => {
	it("returns false for plain text", () => {
		expect(containsPipeTable("just a normal reply with no tables")).toBe(false);
	});

	it("returns false for a lone divider-shaped line with no header row", () => {
		expect(containsPipeTable("above\n|---|---|\nbelow")).toBe(false);
	});

	it("returns true for a pipe table with a header and divider", () => {
		const text = "Results:\n\n| Name | Score |\n|------|-------|\n| Alice | 42 |\n\nDone.";
		expect(containsPipeTable(text)).toBe(true);
	});

	it("returns true even when the table is the only content", () => {
		expect(containsPipeTable("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(true);
	});

	it("ignores a single '|' character used mid-sentence, not as a table row", () => {
		expect(containsPipeTable("pick one: a | b | c")).toBe(false);
	});
});
