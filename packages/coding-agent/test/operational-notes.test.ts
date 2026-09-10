import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendOperationalNote,
	createOperationalNotesToolDefinition,
	OPERATIONAL_NOTES_MAX_BYTES,
} from "../src/core/tools/operational-notes.ts";

describe("operational-notes.md (issue #173)", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "theoses-operational-notes-"));
		path = join(dir, "operational-notes.md");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates the file with a section header and one entry", async () => {
		const added = await appendOperationalNote(path, "Recent Fixes", "fixed the jiti import path");
		expect(added).toBe(true);
		expect(existsSync(path)).toBe(true);

		const content = readFileSync(path, "utf8");
		expect(content).toContain("## Recent Fixes");
		expect(content).toContain("fixed the jiti import path");
	});

	it("dedupes an identical entry under the same section within the same minute", async () => {
		await appendOperationalNote(path, "Error Patterns", "sqlite3 -readonly rejects multi-statement queries");
		const addedAgain = await appendOperationalNote(
			path,
			"Error Patterns",
			"sqlite3 -readonly rejects multi-statement queries",
		);

		expect(addedAgain).toBe(false);
	});

	it("groups entries under their own section headers", async () => {
		await appendOperationalNote(path, "Recent Fixes", "fix one");
		await appendOperationalNote(path, "System Status", "status one");
		await appendOperationalNote(path, "Recent Fixes", "fix two");

		const content = readFileSync(path, "utf8");
		const fixesIndex = content.indexOf("## Recent Fixes");
		const statusIndex = content.indexOf("## System Status");
		expect(fixesIndex).toBeGreaterThanOrEqual(0);
		expect(statusIndex).toBeGreaterThan(fixesIndex);
		expect(content.indexOf("fix two")).toBeGreaterThan(fixesIndex);
	});

	it("the tool refuses new writes once the file exceeds the 32KB cap", async () => {
		const tool = createOperationalNotesToolDefinition({ path });
		// Pre-fill the file past the cap directly, bypassing the tool.
		await appendOperationalNote(path, "Recent Fixes", "x".repeat(OPERATIONAL_NOTES_MAX_BYTES + 10));

		const result = await tool.execute(
			"call-1",
			{ section: "Recent Fixes", content: "another fix" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("32KB cap") });
	});

	it("the tool reports success and the file path on a normal write", async () => {
		const tool = createOperationalNotesToolDefinition({ path });
		const result = await tool.execute(
			"call-1",
			{ section: "System Status", content: "extension loader uses jiti" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Added to operational notes"),
		});
	});
});
