import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMemoryCommand } from "../src/cli/memory-command.ts";
import { clearMemoryNodeCaches, FileMemoryStore } from "../src/core/memory-store.ts";

describe("theoses memory dedup-report", () => {
	let root: string;
	let dir: string;
	let previousMemoryDir: string | undefined;
	let previousExitCode: typeof process.exitCode;
	let output: string[];

	beforeEach(() => {
		root = join(tmpdir(), `theoses-memory-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		dir = join(root, "memories");
		mkdirSync(dir, { recursive: true });
		previousMemoryDir = process.env.THEOSES_MEMORY_DIR;
		process.env.THEOSES_MEMORY_DIR = dir;
		previousExitCode = process.exitCode;
		output = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});

		const store = new FileMemoryStore(dir);
		store.createNode({
			id: "original",
			subject: "The user is Hafiz, the creator of Theoses, and must be addressed as abah",
			at: "2026-09-11T00:00:00.000Z",
		});
		store.createNode({
			id: "restated",
			subject: "The user is Hafiz the creator of Theoses and he must be addressed as abah.",
			at: "2026-09-13T00:00:00.000Z",
		});
		store.createNode({
			id: "unrelated",
			subject: "The VPS has a five point three gigabyte swapfile",
			at: "2026-09-12T00:00:00.000Z",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearMemoryNodeCaches();
		if (previousMemoryDir === undefined) delete process.env.THEOSES_MEMORY_DIR;
		else process.env.THEOSES_MEMORY_DIR = previousMemoryDir;
		process.exitCode = previousExitCode;
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	const snapshot = () =>
		readdirSync(dir)
			.sort()
			.map((name) => [name, readFileSync(join(dir, name), "utf8")]);

	it("prints the counts and the duplicate groups, and says it changed nothing", async () => {
		expect(await handleMemoryCommand(["memory", "dedup-report"])).toBe(true);

		const text = output.join("\n");
		expect(text).toContain("Memory store: 3 nodes");
		expect(text).toMatch(/duplicate nodes .*: 1 in 1 groups/);
		expect(text).toContain("The user is Hafiz, the creator of Theoses");
		expect(text).toContain("Dry run: nothing was changed.");
		expect(process.exitCode).toBe(previousExitCode);
	});

	it("never modifies the memory store", async () => {
		const before = snapshot();

		await handleMemoryCommand(["memory", "dedup-report", "--limit", "0"]);

		expect(snapshot()).toEqual(before);
	});

	it("writes the full report to a file with --json", async () => {
		const path = join(root, "report.json");

		await handleMemoryCommand(["memory", "dedup-report", "--json", path]);

		const report = JSON.parse(readFileSync(path, "utf8"));
		expect(report.nodeCount).toBe(3);
		expect(report.duplicateGroups[0].keep.id).toBe("original");
		expect(report.duplicateGroups[0].remove.map((r: { id: string }) => r.id)).toEqual(["restated"]);
		expect(output.join("\n")).toContain(`Full report written to ${path}`);
	});

	it("limits how many groups are printed", async () => {
		await handleMemoryCommand(["memory", "dedup-report", "--limit", "0"]);

		expect(output.join("\n")).not.toContain("Largest duplicate groups");
	});

	it("rejects bad options with a message and a failing exit code", async () => {
		for (const args of [["--json"], ["--limit", "abc"], ["--limit", "-1"], ["--nope"]]) {
			output.length = 0;
			process.exitCode = undefined;

			expect(await handleMemoryCommand(["memory", "dedup-report", ...args])).toBe(true);

			expect(process.exitCode).toBe(1);
			expect(output.join("\n").length).toBeGreaterThan(0);
		}
	});

	it("reports an unknown subcommand, prints help without one, and ignores other commands", async () => {
		expect(await handleMemoryCommand(["memory", "apply"])).toBe(true);
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;

		output.length = 0;
		expect(await handleMemoryCommand(["memory"])).toBe(true);
		expect(output.join("\n")).toContain("dedup-report");
		expect(process.exitCode).toBeUndefined();

		expect(await handleMemoryCommand(["mcp", "list"])).toBe(false);
		expect(await handleMemoryCommand([])).toBe(false);
	});
});
