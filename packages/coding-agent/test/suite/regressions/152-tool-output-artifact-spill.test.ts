import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { createBashToolDefinition, createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { createGrepToolDefinition } from "../../../src/core/tools/grep.ts";
import { createLsToolDefinition, type LsOperations } from "../../../src/core/tools/ls.ts";
import { getTextOutput } from "../../../src/core/tools/render-utils.ts";

// issue #152: grep/find/ls previously discarded output beyond the byte cap
// permanently; bash already spilled to an unmanaged OS tmpdir file. All four
// now spill the full output to a session-scoped artifact directory (the same
// mechanism used for document attachments) and report the path in the notice,
// so nothing truncated is actually lost.

interface FakeArtifactEntry {
	label: string;
	path: string;
	size: number;
}

function createFakeSessionManager(artifactDir: string) {
	const entries: FakeArtifactEntry[] = [];
	return {
		sessionManager: {
			getArtifactDirectory: () => artifactDir,
			appendArtifact: (label: string, path: string, size: number) => {
				entries.push({ label, path, size });
				return `entry-${entries.length}`;
			},
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		entries,
	};
}

describe("tool output artifact spill (#152)", () => {
	let artifactDir: string;

	beforeEach(() => {
		artifactDir = mkdtempSync(join(tmpdir(), "theoses-artifact-spill-"));
	});

	afterEach(() => {
		rmSync(artifactDir, { recursive: true, force: true });
	});

	it("grep spills full output to the session artifact directory when byte-truncated", async () => {
		const { sessionManager, entries } = createFakeSessionManager(artifactDir);
		const searchDir = mkdtempSync(join(tmpdir(), "theoses-grep-spill-"));
		try {
			const lines = Array.from({ length: 500 }, (_, i) => `match-${i}: ${"x".repeat(60)}`);
			writeFileSync(join(searchDir, "haystack.txt"), lines.join("\n"));

			const definition = createGrepToolDefinition(process.cwd());
			const result = await definition.execute(
				"call-1",
				{ pattern: "match", path: searchDir, limit: 100000 },
				undefined,
				undefined,
				{ sessionManager } as never,
			);
			const details = result.details as
				| { truncation?: { truncated?: boolean }; fullOutputPath?: string }
				| undefined;

			expect(details?.truncation?.truncated).toBe(true);
			expect(details?.fullOutputPath).toBeDefined();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.label).toBe("grep output");
			const spilled = readFileSync(details?.fullOutputPath as string, "utf-8");
			expect(spilled.length).toBeGreaterThan(getTextOutput(result, false).length);
			expect(spilled).toContain("match-499");
		} finally {
			rmSync(searchDir, { recursive: true, force: true });
		}
	});

	it("ls spills full output to the session artifact directory when byte-truncated", async () => {
		const { sessionManager, entries } = createFakeSessionManager(artifactDir);
		const names = Array.from({ length: 2000 }, (_, i) => `file-with-a-long-name-${i}.txt`);
		const operations: LsOperations = {
			exists: () => true,
			stat: () => ({ isDirectory: () => true }),
			readdir: () => names,
		};
		const definition = createLsToolDefinition(process.cwd(), { operations });
		const result = await definition.execute("call-2", { path: "." }, undefined, undefined, {
			sessionManager,
		} as never);
		const details = result.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string } | undefined;

		expect(details?.truncation?.truncated).toBe(true);
		expect(details?.fullOutputPath).toBeDefined();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.label).toBe("ls output");
		const spilled = readFileSync(details?.fullOutputPath as string, "utf-8");
		expect(spilled.length).toBeGreaterThan(getTextOutput(result, false).length);
	});

	it("bash keeps a head preview alongside the tail, and registers the spill artifact", async () => {
		const { sessionManager, entries } = createFakeSessionManager(artifactDir);
		const operations: BashOperations = {
			...createLocalBashOperations(),
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
				}
				return { exitCode: 0 };
			},
		};
		const definition = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await definition.execute("call-3", { command: "many-lines" }, undefined, undefined, {
			sessionManager,
		} as never);
		const output = getTextOutput(result, false);

		// Head (from the very start of output) and tail (the end) are both present,
		// with the omitted middle replaced by a marker rather than silently dropped.
		expect(output).toContain("line-0001");
		expect(output).toContain("line-4000");
		expect(output).not.toContain("line-2000");
		expect(output).toContain("...");

		expect(entries).toHaveLength(1);
		expect(entries[0]?.label).toBe("bash output");
		expect(entries[0]?.path.startsWith(artifactDir)).toBe(true);
		const spilled = readFileSync(entries[0]?.path as string, "utf-8");
		expect(spilled).toContain("line-2000");
	});
});
