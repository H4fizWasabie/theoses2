import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { changedSnippet } from "../src/core/tools/edit-snippet.ts";

const numbered = (count: number) => `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("changedSnippet", () => {
	it("shows a changed line with two lines of context and the real line numbers", () => {
		const before = numbered(20);
		const after = before.replace("line 10\n", "LINE TEN\n");

		expect(changedSnippet(before, after)).toBe(
			["8\tline 8", "9\tline 9", "10\tLINE TEN", "11\tline 11", "12\tline 12"].join("\n"),
		);
	});

	it("separates distant changes with an ellipsis and merges close ones", () => {
		const before = numbered(30);
		const distant = before.replace("line 3\n", "THREE\n").replace("line 25\n", "TWENTY-FIVE\n");
		const close = before.replace("line 10\n", "TEN\n").replace("line 13\n", "THIRTEEN\n");

		expect(changedSnippet(before, distant)).toContain("\n...\n");
		expect(changedSnippet(before, close)).not.toContain("...");
		expect(changedSnippet(before, close).split("\n")).toHaveLength(8);
	});

	it("shows inserted lines, and the neighbours of a deletion", () => {
		const before = numbered(10);
		const inserted = before.replace("line 5\n", "line 5\nnew a\nnew b\n");
		const deleted = before.replace("line 5\n", "");

		expect(changedSnippet(before, inserted)).toContain("6\tnew a\n7\tnew b");
		expect(changedSnippet(before, deleted)).toContain("4\tline 4\n5\tline 6");
	});

	it("caps a large rewrite and says how much it left out", () => {
		const before = numbered(200);
		const after = before
			.split("\n")
			.map((line, i) => (i >= 20 && i < 150 ? `changed ${i}` : line))
			.join("\n");

		const snippet = changedSnippet(before, after);

		expect(snippet.split("\n").length).toBeLessThanOrEqual(26);
		expect(snippet).toMatch(/\(\d+ more lines not shown\)/);
	});

	it("shortens very long lines", () => {
		const long = `x = "${"a".repeat(600)}"`;
		expect(changedSnippet("a\n", `${long}\n`).length).toBeLessThan(400);
	});

	it("is empty when nothing changed", () => {
		expect(changedSnippet("same\n", "same\n")).toBe("");
	});
});

describe("edit tool result snippet", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-snippet-"));
		writeFileSync(join(dir, "a.txt"), numbered(20));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const run = async (options?: { resultSnippet?: boolean }) => {
		const result = await createEditToolDefinition(dir, options).execute(
			"call",
			{ path: "a.txt", edits: [{ oldText: "line 10", newText: "LINE TEN" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	};

	it("adds the lines around the change when asked, so the model need not read the file back", async () => {
		const text = await run({ resultSnippet: true });

		expect(text).toContain("Successfully replaced 1 block(s) in a.txt.");
		expect(text).toContain("10\tLINE TEN");
		expect(text).toContain("8\tline 8");
	});

	it("leaves the result as it was otherwise", async () => {
		expect(await run()).toBe("Successfully replaced 1 block(s) in a.txt.");
	});
});
