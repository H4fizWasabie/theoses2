import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistFailedEvalSession } from "../../src/vitest-evals/artifacts.ts";

describe("persistFailedEvalSession", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("writes the session under failed-sessions/<runId>.jsonl", async () => {
		directory = await mkdtemp(join(tmpdir(), "failed-session-"));
		const path = await persistFailedEvalSession(directory, "run-1", '{"a":1}\n');
		expect(path).toBe(join(directory, "failed-sessions", "run-1.jsonl"));
		expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
	});

	it("rejects a run ID that would escape the directory", async () => {
		directory = await mkdtemp(join(tmpdir(), "failed-session-"));
		await expect(persistFailedEvalSession(directory, "../evil", "x")).rejects.toThrow("Invalid eval run ID");
	});
});
