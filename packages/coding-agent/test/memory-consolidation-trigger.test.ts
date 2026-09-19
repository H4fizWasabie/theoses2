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
	selectConsolidationWindow,
	shouldTriggerConsolidation,
} from "../src/core/memory-consolidation.ts";
import type { FileMemoryStore } from "../src/core/memory-store.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SessionEntry, SessionManager } from "../src/core/session-manager.ts";

describe("shouldTriggerConsolidation", () => {
	const originalFetch = global.fetch;
	const originalApiKey = process.env.OPENROUTER_API_KEY;

	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key";
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = originalApiKey;
	});

	function mockJevNoul(noul: number | undefined): void {
		global.fetch = vi.fn(async () =>
			noul === undefined
				? new Response("boom", { status: 500 })
				: new Response(JSON.stringify({ answers: { answer: { type: "noul", noul } } }), { status: 200 }),
		) as unknown as typeof fetch;
	}

	it("fires when Jev reads the message as a completion signal", async () => {
		mockJevNoul(0.95);
		expect(await shouldTriggerConsolidation("Thanks a lot for that!", 3)).toBe(true);
	});

	it("does not fire when Jev reads the message as ordinary, under the turn ceiling", async () => {
		mockJevNoul(0.05);
		expect(await shouldTriggerConsolidation("what's the weather like", 5)).toBe(false);
	});

	it("does not fire when the Jev call fails, under the turn ceiling", async () => {
		mockJevNoul(undefined);
		expect(await shouldTriggerConsolidation("continue", 5)).toBe(false);
	});

	it("fires once the turn ceiling is reached, bypassing Jev entirely", async () => {
		// Below the ceiling, the (failing) Jev call is still made and its failure means "don't
		// trigger". At/above the ceiling, the ceiling check short-circuits before Jev is ever
		// called, so it fires even though a Jev call here would fail.
		mockJevNoul(undefined);
		expect(await shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING - 1)).toBe(false);
		expect(await shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING)).toBe(true);
	});
});

describe("selectConsolidationWindow", () => {
	function branchOf(count: number, prefix = "e"): SessionEntry[] {
		return Array.from(
			{ length: count },
			(_, i) => ({ id: `${prefix}${i}`, type: "message" }) as unknown as SessionEntry,
		);
	}

	it("returns the messages after the checkpointed entry", () => {
		const { window, checkpointMissing } = selectConsolidationWindow(branchOf(10), "e6");

		expect(checkpointMissing).toBe(false);
		expect(window.map((entry) => entry.id)).toEqual(["e7", "e8", "e9"]);
	});

	it("returns nothing when the checkpoint is the last entry", () => {
		expect(selectConsolidationWindow(branchOf(5), "e4").window).toEqual([]);
	});

	it("skips entries that are not messages", () => {
		const branch = [
			{ id: "a", type: "message" },
			{ id: "b", type: "custom" },
			{ id: "c", type: "message" },
		] as unknown as SessionEntry[];

		expect(selectConsolidationWindow(branch, "a").window.map((entry) => entry.id)).toEqual(["c"]);
	});

	it("reads a session with no checkpoint in full, as before", () => {
		const { window, checkpointMissing } = selectConsolidationWindow(branchOf(500), null);

		expect(checkpointMissing).toBe(false);
		expect(window).toHaveLength(500);
	});

	it("takes only the last chunk when the checkpoint entry is not in the branch (another bot's checkpoint)", () => {
		// The 2026-09-19 incident: staging saw the production bot's entry id and replayed its whole history.
		const { window, checkpointMissing } = selectConsolidationWindow(branchOf(15000), "entry-from-the-other-bot");

		expect(checkpointMissing).toBe(true);
		expect(window).toHaveLength(CONSOLIDATION_TURN_CEILING);
		expect(window[window.length - 1].id).toBe("e14999");
		expect(window[0].id).toBe(`e${15000 - CONSOLIDATION_TURN_CEILING}`);
	});

	it("still reads a short session in full when its checkpoint is missing", () => {
		const { window, checkpointMissing } = selectConsolidationWindow(branchOf(12), "gone");

		expect(checkpointMissing).toBe(true);
		expect(window).toHaveLength(12);
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
