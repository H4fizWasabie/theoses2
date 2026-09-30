import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { changedFragment } from "../src/core/tools/edit-siblings.ts";

// After an edit the tool says where else the replaced text appears, so a fix that has siblings is not left half done
// (the model reads the failing test, fixes what it names, and stops).
describe("edit sibling hint", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-sibling-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, content: string) => {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	};
	async function edit(path: string, oldText: string, newText: string): Promise<string> {
		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"call",
			{ path, edits: [{ oldText, newText }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	}

	it("names the other files that contain the text the edit replaced", async () => {
		write("stats.mjs", "const sorted = [...nums].sort();\n");
		write("report.mjs", "return [...nums].sort().reverse();\n");
		write("invoice.mjs", "return lines.map((l) => l.amount).sort();\n");

		const text = await edit("stats.mjs", "[...nums].sort()", "[...nums].sort((a, b) => a - b)");

		expect(text).toContain("also appears in");
		// Worded as part of the task: a softer "fix it there too" was read and then declined as unrequested work.
		expect(text).toContain("part of this bug, not extra work");
		expect(text).toContain("report.mjs:1");
		expect(text).toContain("invoice.mjs:1");
		expect(text).not.toContain("stats.mjs:1");
		expect(readFileSync(join(dir, "stats.mjs"), "utf8")).toContain("(a, b) => a - b");
	});

	it("says nothing when the text is not elsewhere", async () => {
		write("a.mjs", "export const limit = 100;\n");
		write("b.mjs", "export const other = true;\n");

		expect(await edit("a.mjs", "limit = 100", "limit = 200")).not.toContain("also appears");
	});

	it("does not list the edited file itself, even when the new text still contains the fragment", async () => {
		write("a.mjs", "export const limit = 100000;\n");
		write("b.mjs", "export const other = 100000;\n");

		const text = await edit("a.mjs", "limit = 100000;", "limit = 100000 * 2;");

		expect(text).toContain("b.mjs:1");
		expect(text).not.toContain("a.mjs:1");
	});

	it("says nothing for a short fragment that would match everywhere", async () => {
		write("a.mjs", "let x = 1;\n");
		write("b.mjs", "let y = 1;\n");

		expect(await edit("a.mjs", "= 1", "= 2")).not.toContain("also appears");
	});

	it("leaves out node_modules, tests and other non-source folders", async () => {
		write("a.mjs", "return items.sort();\n");
		write("node_modules/dep/index.js", "return items.sort();\n");
		write("a.test.mjs", "return items.sort();\n");
		write("dist/out.js", "return items.sort();\n");

		expect(await edit("a.mjs", "items.sort()", "items.sort(byId)")).not.toContain("also appears");
	});

	it("lists at most five files and says how many more", async () => {
		write("a.mjs", "return items.sort();\n");
		for (let i = 0; i < 8; i++) write(`copy${i}.mjs`, "return items.sort();\n");

		const text = await edit("a.mjs", "items.sort()", "items.sort(byId)");

		expect(text.match(/copy\d\.mjs:1/g)).toHaveLength(5);
		expect(text).toContain("and 3 more");
	});

	it("says nothing for a file outside the working directory, whose neighbours are not this project", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "edit-elsewhere-"));
		try {
			write("b.mjs", "return items.sort();\n");
			writeFileSync(join(elsewhere, "a.mjs"), "return items.sort();\n");

			expect(await edit(join(elsewhere, "a.mjs"), "items.sort()", "items.sort(byId)")).not.toContain("also appears");
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("still succeeds when the edited file is in a directory the search cannot read", async () => {
		write("a.mjs", "return items.sort();\n");
		write("locked/b.mjs", "return items.sort();\n");

		expect(await edit("a.mjs", "items.sort()", "items.sort(byId)")).toContain("Successfully replaced");
	});
});

describe("changedFragment", () => {
	it("keeps the call around an insertion, so the mistake can be searched for", () => {
		expect(changedFragment("[...nums].sort()", "[...nums].sort((a, b) => a - b)")).toBe(".sort()");
	});

	it("uses the replaced text itself when something was replaced", () => {
		expect(changedFragment("limit = 100;", "limit = 200;")).toBe("100");
	});

	it("is empty when nothing changed", () => {
		expect(changedFragment("same", "same")).toBe("");
	});
});
