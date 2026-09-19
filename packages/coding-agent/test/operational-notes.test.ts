import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendOperationalNote,
	createOperationalNotesToolDefinition,
	makeRoomForNote,
	OPERATIONAL_NOTES_TARGET_BYTES,
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

	describe("auto-archive when the file nears its cap", () => {
		const archivePath = () => join(dir, "operational-notes-archive.md");
		const entryLine = (day: number, section: string, text: string) =>
			`- 2026-09-${String(day).padStart(2, "0")} 10:00 | ${section}: ${text}`;

		/** Writes a notes file of `count` entries, each ~`entryBytes` long, oldest day first, under two sections. */
		function seed(count: number, entryBytes: number): string[] {
			const fixes: string[] = [];
			const status: string[] = [];
			for (let i = 0; i < count; i++) {
				const line = entryLine(1 + i, i % 2 === 0 ? "fix" : "status", `n${i} ${"x".repeat(entryBytes)}`);
				(i % 2 === 0 ? fixes : status).push(line);
			}
			writeFileSync(
				path,
				`# Notes\n\n## Recent Fixes\n${fixes.join("\n")}\n\n## System Status\n${status.join("\n")}\n`,
			);
			return [...fixes, ...status];
		}

		const runTool = (tool: ReturnType<typeof createOperationalNotesToolDefinition>, content: string) =>
			tool.execute("call", { section: "Recent Fixes", content }, undefined, undefined, {} as never);

		it("does nothing while the file plus the new line stays under the trigger mark", async () => {
			seed(26, 1000); // ~26KB, about 80% full
			const before = readFileSync(path, "utf8");
			const moved = await makeRoomForNote(path, 100);

			expect(moved).toBe(0);
			expect(readFileSync(path, "utf8")).toBe(before);
			expect(existsSync(archivePath())).toBe(false);
		});

		it("triggers on the size after the new line, not the size before it", async () => {
			seed(28, 1000); // ~29.0KB: a 100-byte line stays under the ~29.5KB trigger, a 1000-byte line does not
			expect(await makeRoomForNote(path, 100)).toBe(0);
			expect(await makeRoomForNote(path, 1000)).toBeGreaterThan(0);
		});

		it("archives the oldest entries down to the target and the write then succeeds", async () => {
			seed(30, 1000); // ~30KB, past the 90% hard mark
			const tool = createOperationalNotesToolDefinition({ path });
			const result = await runTool(tool, "brand new fix");

			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Added to operational notes") });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("oldest") });
			const content = readFileSync(path, "utf8");
			expect(Buffer.byteLength(content)).toBeLessThanOrEqual(OPERATIONAL_NOTES_TARGET_BYTES + 200);
			expect(content).toContain("brand new fix");
			expect(content).not.toContain("n0 "); // oldest went
			expect(content).toContain("n29 "); // newest stayed

			const archive = readFileSync(archivePath(), "utf8");
			expect(archive).toContain("n0 ");
			expect(archive).toContain("## Recent Fixes");
			expect(archive).toMatch(/# Archived \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\d+ oldest\)/);
		});

		it("appends to the archive on later runs instead of overwriting it", async () => {
			seed(30, 1000);
			await makeRoomForNote(path, 100);
			const first = readFileSync(archivePath(), "utf8");
			seed(30, 1000);
			await makeRoomForNote(path, 100);
			const second = readFileSync(archivePath(), "utf8");

			expect(second.startsWith(first)).toBe(true);
			expect(second.match(/# Archived/g)).toHaveLength(2);
		});

		it("reports how many entries it moved in the tool result", async () => {
			seed(30, 1000);
			const tool = createOperationalNotesToolDefinition({ path });
			const result = await runTool(tool, "another fix");

			expect(result.content[0]).toMatchObject({
				text: expect.stringMatching(/Moved the \d+ oldest entries to operational-notes-archive\.md/),
			});
		});

		it("drops a section heading only when all of its entries were archived", async () => {
			writeFileSync(
				path,
				[
					"# Notes",
					"",
					"## Old Section",
					entryLine(1, "old", `only ${"x".repeat(10000)}`),
					"",
					"## Empty From The Start",
					"",
					"## Busy Section",
					entryLine(2, "busy", `a ${"x".repeat(10000)}`),
					entryLine(20, "busy", `b ${"x".repeat(10000)}`),
					"",
				].join("\n"),
			);
			await makeRoomForNote(path, 100);
			const content = readFileSync(path, "utf8");

			expect(content).not.toContain("## Old Section");
			expect(content).toContain("## Empty From The Start");
			expect(content).toContain("## Busy Section");
			expect(content).toContain("b xxx");
		});

		it("archives hand-written lines without a timestamp only after every timestamped entry", async () => {
			writeFileSync(
				path,
				`## Notes\n- hand written line ${"x".repeat(10000)}\n${entryLine(3, "old", `stamped ${"x".repeat(10000)}`)}\n${entryLine(4, "new", `stamped2 ${"x".repeat(10000)}`)}\n`,
			);
			await makeRoomForNote(path, 100);
			const content = readFileSync(path, "utf8");

			expect(content).toContain("hand written line");
			expect(content).not.toContain("stamped");
		});

		it("falls back to the plain cap check when the archive cannot be written", async () => {
			seed(30, 1000);
			mkdirSync(archivePath()); // a directory where the archive file should be
			const tool = createOperationalNotesToolDefinition({ path });
			const result = await runTool(tool, "another fix");

			expect(result.content[0]).toMatchObject({ type: "text" });
			expect(readFileSync(path, "utf8")).toContain("n0 "); // nothing was lost
		});

		it("does not lose entries when several writes arrive at once", async () => {
			const tool = createOperationalNotesToolDefinition({ path });
			await Promise.all(["one", "two", "three", "four", "five"].map((word) => runTool(tool, `parallel ${word}`)));
			const content = readFileSync(path, "utf8");

			for (const word of ["one", "two", "three", "four", "five"]) expect(content).toContain(`parallel ${word}`);
		});

		it("collapses a multi-line note into one entry line", async () => {
			await appendOperationalNote(path, "Recent Fixes", "first line\nsecond line");
			expect(readFileSync(path, "utf8")).toContain("first line second line");
		});
	});
});
