import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodicStore } from "../src/core/episodic-store.ts";
import {
	CONSOLIDATION_TURN_CEILING,
	capTranscript,
	MAX_TRANSCRIPT_CHARS,
	maybeRunConsolidation,
	shouldTriggerConsolidation,
} from "../src/core/memory-consolidation.ts";
import type { FileMemoryStore } from "../src/core/memory-store.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SessionManager } from "../src/core/session-manager.ts";

describe("shouldTriggerConsolidation", () => {
	it("fires on a completion keyword, case-insensitive, anywhere in the message", () => {
		expect(shouldTriggerConsolidation("Thanks a lot for that!", 3)).toBe(true);
		expect(shouldTriggerConsolidation("GREAT JOB on the deploy", 1)).toBe(true);
	});

	it("does not fire on an ordinary message under the turn ceiling", () => {
		expect(shouldTriggerConsolidation("what's the weather like", 5)).toBe(false);
	});

	it("fires once the turn ceiling is reached even without a keyword", () => {
		expect(shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING - 1)).toBe(false);
		expect(shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING)).toBe(true);
	});
});

describe("capTranscript (issue #177)", () => {
	it("leaves a short transcript untouched", () => {
		expect(capTranscript("short")).toBe("short");
	});

	it("keeps only the tail once the transcript exceeds the cap", () => {
		const text = "x".repeat(MAX_TRANSCRIPT_CHARS + 500);
		const capped = capTranscript(text);
		expect(capped.length).toBe(MAX_TRANSCRIPT_CHARS);
		expect(text.endsWith(capped)).toBe(true);
	});
});

describe("maybeRunConsolidation cooldown and in-flight guards (issue #177)", () => {
	let checkpointDir: string;
	let checkpointPath: string;
	let previousEnv: string | undefined;

	let previousEpisodicEnv: string | undefined;

	beforeEach(() => {
		checkpointDir = mkdtempSync(join(tmpdir(), "theoses-consolidation-checkpoints-"));
		checkpointPath = join(checkpointDir, "consolidation-checkpoints.json");
		previousEnv = process.env.THEOSES_CONSOLIDATION_CHECKPOINTS;
		process.env.THEOSES_CONSOLIDATION_CHECKPOINTS = checkpointPath;
		previousEpisodicEnv = process.env.THEOSES_EPISODIC_DB;
		process.env.THEOSES_EPISODIC_DB = join(checkpointDir, "episodes.db");
	});

	afterEach(() => {
		if (previousEnv === undefined) delete process.env.THEOSES_CONSOLIDATION_CHECKPOINTS;
		else process.env.THEOSES_CONSOLIDATION_CHECKPOINTS = previousEnv;
		if (previousEpisodicEnv === undefined) delete process.env.THEOSES_EPISODIC_DB;
		else process.env.THEOSES_EPISODIC_DB = previousEpisodicEnv;
		rmSync(checkpointDir, { recursive: true, force: true });
	});

	function fakeSessionManager(getBranch: () => never[]): SessionManager {
		return { getBranch } as unknown as SessionManager;
	}

	it("does not list the session branch while a prior failure's cooldown is active", async () => {
		writeFileSync(
			checkpointPath,
			JSON.stringify({ "telegram:abc": { lastEntryId: null, lastFailureAt: new Date().toISOString() } }),
		);
		const getBranch = vi.fn(() => []);
		maybeRunConsolidation({
			cwd: "/tmp",
			channel: "telegram",
			channelSessionId: "abc",
			userMessageText: "continue",
			mainSessionManager: fakeSessionManager(getBranch),
			modelRuntime: {} as unknown as ModelRuntime,
			memoryStore: {} as unknown as FileMemoryStore,
			episodicStore: {} as unknown as EpisodicStore,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("lists the session branch again once the cooldown has passed", async () => {
		const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		writeFileSync(
			checkpointPath,
			JSON.stringify({ "telegram:abc": { lastEntryId: null, lastFailureAt: twentyMinutesAgo } }),
		);
		const getBranch = vi.fn(() => []);
		maybeRunConsolidation({
			cwd: "/tmp",
			channel: "telegram",
			channelSessionId: "abc",
			userMessageText: "continue",
			mainSessionManager: fakeSessionManager(getBranch),
			modelRuntime: {} as unknown as ModelRuntime,
			memoryStore: {} as unknown as FileMemoryStore,
			episodicStore: {} as unknown as EpisodicStore,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(getBranch).toHaveBeenCalledTimes(1);
	});

	it("does not run two overlapping passes for the same channel session", async () => {
		// episodicStore/memoryStore intentionally omitted here (unlike the other tests in this
		// block): their real construction is the first genuine async yield point in
		// runIfTriggered, which is what makes it possible for a second call to actually interleave
		// with the first one's still-in-flight execution and exercise the in-flight guard for real.
		const getBranch = vi.fn(() => []);
		const options = {
			cwd: "/tmp",
			channel: "telegram",
			channelSessionId: "overlap-test",
			userMessageText: "continue",
			mainSessionManager: fakeSessionManager(getBranch),
			modelRuntime: {} as unknown as ModelRuntime,
		};
		maybeRunConsolidation(options);
		maybeRunConsolidation(options);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getBranch).toHaveBeenCalledTimes(1);
	});
});
