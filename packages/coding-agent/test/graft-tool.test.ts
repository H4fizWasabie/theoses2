import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({
	execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: run }),
}));

import {
	createGraftToolDefinition,
	GRAFT_MAX_BUFFER,
	GRAFT_TIMEOUT_MS,
	type GraftToolInput,
} from "../src/core/tools/graft.ts";

function graph(repo: string): void {
	mkdirSync(join(repo, "graft", ".graph"), { recursive: true });
	writeFileSync(join(repo, "graft", ".graph", "wiring.json"), "{}");
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("explorer's query-only Graft tool", () => {
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "theoses-graft-test-"));
		graph(repo);
		run.mockReset().mockResolvedValue({ stdout: "src/retry.ts:42", stderr: "" });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(repo, { recursive: true, force: true });
	});

	async function query(input: GraftToolInput, signal?: AbortSignal, cwd = repo) {
		return createGraftToolDefinition(cwd).execute("graft-test", input, signal, undefined, {} as never);
	}

	it.each([
		[{ command: "ask", target: "retry" }, ["ask", "--no-refresh", "--source", "--limit", "4"]],
		[{ command: "ask", target: "retry", limit: 8 }, ["ask", "--no-refresh", "--source", "--limit", "8"]],
		[{ command: "skeleton", target: "src/retry.ts" }, ["skeleton", "--no-refresh"]],
		[{ command: "callers", target: "retry" }, ["callers", "--no-refresh", "--depth", "1"]],
		[{ command: "callers", target: "retry", depth: 3 }, ["callers", "--no-refresh", "--depth", "3"]],
	] as const)("runs only fixed options for %j", async (input, prefix) => {
		const result = await query(input);
		expect(run).toHaveBeenCalledExactlyOnceWith(
			"graft",
			[...prefix, "--", input.target, repo],
			expect.objectContaining({
				cwd: repo,
				shell: false,
				timeout: GRAFT_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: GRAFT_MAX_BUFFER,
				env: expect.objectContaining({ DO_NOT_TRACK: "1", NO_COLOR: "1" }),
			}),
		);
		expect(text(result)).toContain("src/retry.ts:42");
		expect(text(result)).toContain("refresh disabled");
		expect(result.details.available).toBe(true);
	});

	it.each(["ask", "skeleton", "callers"] as const)(
		"forwards only PATH, HOME and fixed flags to %s, never parent secrets or Node options",
		async (command) => {
			vi.stubEnv("PATH", "/test/bin");
			vi.stubEnv("HOME", "/test/home");
			vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-secret");
			vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-secret");
			vi.stubEnv("NODE_OPTIONS", "--require=/test/injected.js");
			vi.stubEnv("HTTP_PROXY", "http://test-proxy");
			vi.stubEnv("GRAFT_EXTRA_SECRET", "test-unrecognized-secret");
			vi.stubEnv("DO_NOT_TRACK", "0");
			vi.stubEnv("NO_COLOR", "0");
			await query({ command, target: command === "skeleton" ? "src/retry.ts" : "retry" });
			expect(run.mock.calls[0][2].env).toEqual({
				PATH: "/test/bin",
				HOME: "/test/home",
				DO_NOT_TRACK: "1",
				NO_COLOR: "1",
			});
		},
	);

	it("passes shell metacharacters as literal query data, never as a shell command", async () => {
		const target = "retry; touch /tmp/not-a-command $(id)";
		await query({ command: "ask", target });
		expect(run.mock.calls[0][1].slice(-3)).toEqual(["--", target, repo]);
		expect(run.mock.calls[0][2].shell).toBe(false);
	});

	it.each([
		{ command: "build", target: "x" },
		{ command: "init", target: "x" },
		{ command: "upgrade", target: "x" },
		{ command: "ask", target: "--full" },
		{ command: "ask", target: "x\ny" },
		{ command: "ask", target: "" },
		{ command: "ask", target: "x".repeat(501) },
		{ command: "ask", target: "x", args: ["--refresh"] },
		{ command: "skeleton", target: "../secret.ts" },
		{ command: "skeleton", target: "/etc/passwd" },
		{ command: "skeleton", target: "C:\\secret.ts" },
		{ command: "skeleton", target: "src/../../secret.ts" },
		{ command: "ask", target: "x", limit: 9 },
		{ command: "ask", target: "x", limit: 1.5 },
		{ command: "callers", target: "x", depth: 4 },
		{ command: "callers", target: "x", depth: "all" },
		{ command: "skeleton", target: "x", limit: 1 },
		{ command: "ask", target: "x", depth: 1 },
		{ command: "ask", target: "x", path: "" },
		{ command: "ask", target: "x", path: "x\u0000" },
	])("rejects unsafe/unsupported input %j before executing", async (input) => {
		await expect(query(input as GraftToolInput)).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
	});

	it("finds the nearest ancestor graph from a subdirectory", async () => {
		const subdir = join(repo, "packages", "feature");
		mkdirSync(subdir, { recursive: true });
		await query({ command: "ask", target: "retry" }, undefined, subdir);
		expect(run.mock.calls[0][2].cwd).toBe(repo);
	});

	it("does not use a parent graph for an unindexed nested repository", async () => {
		const nested = join(repo, "nested");
		mkdirSync(nested);
		writeFileSync(join(nested, ".git"), "gitdir: somewhere");
		const result = await query({ command: "ask", target: "retry" }, undefined, nested);
		expect(result.details.available).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("honors an explicit repository path rather than falling back to an ancestor", async () => {
		const nested = join(repo, "nested");
		mkdirSync(nested);
		const missing = await query({ command: "ask", target: "retry", path: "nested" });
		expect(text(missing)).toContain("not evidence that the code is absent");
		expect(run).not.toHaveBeenCalled();
		graph(nested);
		await query({ command: "ask", target: "retry", path: "nested" });
		expect(run.mock.calls[0][2].cwd).toBe(nested);
	});

	it("returns actionable fallback when Graft is missing", async () => {
		run.mockRejectedValue(Object.assign(new Error("spawn graft ENOENT"), { code: "ENOENT" }));
		const result = await query({ command: "ask", target: "retry" });
		expect(result.details.available).toBe(false);
		expect(text(result)).toContain("No code search was performed");
	});

	it("does not spawn when already aborted", async () => {
		await expect(query({ command: "ask", target: "retry" }, AbortSignal.abort())).rejects.toThrow(
			"Operation aborted",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("forwards cancellation and reports an in-flight abort", async () => {
		const controller = new AbortController();
		run.mockImplementation(
			(_binary, _args, options) =>
				new Promise((_resolve, reject) => {
					expect(options.signal).toBe(controller.signal);
					options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const pending = query({ command: "ask", target: "retry" }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Operation aborted");
	});

	it("reports a process killed by the fixed timeout", async () => {
		run.mockRejectedValue(Object.assign(new Error("killed"), { killed: true }));
		await expect(query({ command: "ask", target: "retry" })).rejects.toThrow("10-second time limit");
	});

	it("reports query errors rather than claiming no matches", async () => {
		run.mockRejectedValue(Object.assign(new Error("exit 1"), { code: 1, stderr: "broken wiring graph" }));
		await expect(query({ command: "ask", target: "retry" })).rejects.toThrow("broken wiring graph");
	});

	it.each(["evidence\n".repeat(1000), `evidence\n${"x".repeat(10_000)}`])(
		"bounds oversized output without writing spill artifacts",
		async (stdout) => {
			run.mockResolvedValue({ stdout, stderr: "" });
			const result = await query({ command: "ask", target: "retry" });
			expect(Buffer.byteLength(text(result))).toBeLessThan(6500);
			expect(text(result)).toContain("truncated");
			expect(result.details.truncated).toBe(true);
		},
	);

	it("returns explicitly partial evidence when the process output buffer limit is reached", async () => {
		run.mockRejectedValue(
			Object.assign(new Error("too much output"), {
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				stdout: "src/retry.ts:42\n",
				stderr: "",
			}),
		);
		const result = await query({ command: "ask", target: "retry" });
		expect(text(result)).toContain("src/retry.ts:42");
		expect(text(result)).toContain("truncated");
		expect(result.details.truncated).toBe(true);
	});
});
