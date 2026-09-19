import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionsCommand } from "../src/cli/sessions-command.ts";
import { hydrateImages } from "../src/core/session-images.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("theoses sessions externalize-images", () => {
	let root: string;
	let output: string[];
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		root = join(tmpdir(), `theoses-sessions-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		previousExitCode = process.exitCode;
		output = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			output.push(args.join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = previousExitCode;
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	/** A session log in the old format, with one inline image, last modified ten minutes ago. */
	function legacyLog(): { file: string; data: string } {
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.create(root, sessionDir);
		const data = Buffer.alloc(8000, 5).toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		} as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage,
			stopReason: "stop",
			timestamp: 1,
		} as never);
		const file = manager.getSessionFile() as string;
		const lines = readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		hydrateImages(lines, manager.getArtifactDirectory());
		writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(file, old, old);
		return { file, data };
	}

	it("reports what a dry run would move and changes nothing", async () => {
		const { file, data } = legacyLog();
		const before = readFileSync(file, "utf8");

		expect(await handleSessionsCommand(["sessions", "externalize-images", file, "--dry-run"])).toBe(true);

		expect(output.join("\n")).toContain("1 image(s)");
		expect(output.join("\n")).toContain("Dry run: nothing was changed.");
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(before).toContain(data);
		expect(process.exitCode).toBe(previousExitCode);
	});

	it("moves the images and says where the original is kept", async () => {
		const { file, data } = legacyLog();

		await handleSessionsCommand(["sessions", "externalize-images", file]);

		expect(readFileSync(file, "utf8")).not.toContain(data);
		expect(output.join("\n")).toContain("Moved 1 image(s)");
		expect(existsSync(`${file}.pre-image-externalize.bak`)).toBe(true);
	});

	it("explains a refusal for a file that is still being written, with a failing exit code", async () => {
		const { file } = legacyLog();
		const now = new Date();
		utimesSync(file, now, now);

		await handleSessionsCommand(["sessions", "externalize-images", file]);

		expect(process.exitCode).toBe(1);
		expect(output.join("\n")).toContain("modified in the last 30 seconds");
	});

	it("rejects bad arguments, an unknown subcommand and a missing file", async () => {
		for (const args of [
			["externalize-images"],
			["externalize-images", "a.jsonl", "b.jsonl"],
			["externalize-images", "--nope"],
			["nope"],
		]) {
			output.length = 0;
			process.exitCode = undefined;

			expect(await handleSessionsCommand(["sessions", ...args])).toBe(true);

			expect(process.exitCode).toBe(1);
			expect(output.join("\n").length).toBeGreaterThan(0);
		}
		process.exitCode = undefined;
		await handleSessionsCommand(["sessions", "externalize-images", join(root, "missing.jsonl")]);
		expect(process.exitCode).toBe(1);
	});

	it("prints help without a subcommand and ignores other commands", async () => {
		expect(await handleSessionsCommand(["sessions"])).toBe(true);
		expect(output.join("\n")).toContain("externalize-images");
		expect(await handleSessionsCommand(["memory", "dedup-report"])).toBe(false);
		expect(await handleSessionsCommand([])).toBe(false);
	});
});
