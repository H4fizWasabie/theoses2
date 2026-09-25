import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/background-call.ts", () => ({ backgroundCall: vi.fn() }));

import { backgroundCall } from "../src/core/background-call.ts";
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

	const range = (id: string, firstEntryId: string, lastEntryId: string) =>
		({ id, type: "promoted_range", firstEntryId, lastEntryId }) as unknown as SessionEntry;

	it("reads a session nothing has promoted in full", () => {
		expect(selectConsolidationWindow(branchOf(500))).toHaveLength(500);
	});

	it("skips every message a promoted range covers, from consolidation or save_note alike", () => {
		const branch = [...branchOf(4), range("r1", "e0", "e1"), ...branchOf(3, "f"), range("r2", "f1", "f1")];

		expect(selectConsolidationWindow(branch).map((entry) => entry.id)).toEqual(["e2", "e3", "f0", "f2"]);
	});

	it("skips entries that are not messages", () => {
		const branch = [
			{ id: "a", type: "message" },
			{ id: "b", type: "custom" },
			{ id: "c", type: "message" },
		] as unknown as SessionEntry[];

		expect(selectConsolidationWindow(branch).map((entry) => entry.id)).toEqual(["a", "c"]);
	});

	it("ignores a range whose entries are not in this branch", () => {
		expect(selectConsolidationWindow([...branchOf(3), range("r", "elsewhere", "e1")])).toHaveLength(3);
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

	function fakeSessionManager(getBranch: () => SessionEntry[]) {
		return { getBranch, appendPromotedRange: vi.fn((_first: string, _last: string) => "range") };
	}

	const userMessage = (id: string, text: string) =>
		({ id, type: "message", message: { role: "user", content: text, timestamp: 1 } }) as unknown as SessionEntry;
	/** A full turn-ceiling window, so the trigger fires without asking Jev. Empty text makes the pass skip its model call. */
	const ceilingBranch = (text = "") =>
		Array.from({ length: CONSOLIDATION_TURN_CEILING }, (_, i) => userMessage(`m${i}`, text));

	function run(sessionManager: ReturnType<typeof fakeSessionManager>, channelSessionId: string): void {
		maybeRunConsolidation({
			cwd: "/tmp",
			channel: "telegram",
			channelSessionId,
			userMessageText: "continue",
			mainSessionManager: sessionManager as unknown as SessionManager,
			modelRuntime: {} as unknown as ModelRuntime,
			memoryStore: { remember: () => [] } as unknown as FileMemoryStore,
			episodicStore: {} as unknown as EpisodicStore,
		});
	}

	it("records a consolidated chunk as a promoted range in the session log", async () => {
		const manager = fakeSessionManager(() => ceilingBranch());
		run(manager, "record");
		await vi.waitFor(() =>
			expect(manager.appendPromotedRange).toHaveBeenCalledWith("m0", `m${CONSOLIDATION_TURN_CEILING - 1}`),
		);
	});

	it("skips passes during a failure's cooldown and runs again once it has passed", async () => {
		vi.mocked(backgroundCall).mockRejectedValueOnce(new Error("provider down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const getBranch = vi.fn(() => ceilingBranch("remember this"));
		const manager = fakeSessionManager(getBranch);
		try {
			run(manager, "cooldown");
			await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
			run(manager, "cooldown");
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(getBranch).toHaveBeenCalledTimes(1);
			expect(manager.appendPromotedRange).not.toHaveBeenCalled();

			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + 20 * 60 * 1000);
			run(manager, "cooldown");
			await vi.waitFor(() => expect(getBranch).toHaveBeenCalledTimes(2));
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("moves a legacy checkpoint into the session log once, then deletes the file", async () => {
		writeFileSync(checkpointPath, JSON.stringify({ "telegram:migrate": { lastEntryId: "m2" } }));
		const manager = fakeSessionManager(() => ceilingBranch());
		run(manager, "migrate");
		await vi.waitFor(() => expect(manager.appendPromotedRange).toHaveBeenCalledWith("m0", "m2"));
		expect(existsSync(checkpointPath)).toBe(false);
	});

	it("keeps the old last-chunk rule for a legacy checkpoint id missing from the branch", async () => {
		writeFileSync(
			checkpointPath,
			JSON.stringify({ "telegram:gone": { lastEntryId: "other-bot" }, "telegram:kept": { lastEntryId: "x" } }),
		);
		const branch = Array.from({ length: CONSOLIDATION_TURN_CEILING + 5 }, (_, i) => userMessage(`m${i}`, ""));
		const manager = fakeSessionManager(() => branch);
		run(manager, "gone");
		await vi.waitFor(() => expect(manager.appendPromotedRange).toHaveBeenCalledWith("m0", "m4"));
		expect(JSON.parse(readFileSync(checkpointPath, "utf8"))).toEqual({ "telegram:kept": { lastEntryId: "x" } });
	});

	it("does not run two overlapping passes for the same channel session", async () => {
		// episodicStore/memoryStore intentionally omitted here (unlike the other tests in this
		// block): their real construction is the first genuine async yield point in
		// runIfTriggered, which is what makes it possible for a second call to actually interleave
		// with the first one's still-in-flight execution and exercise the in-flight guard for real.
		const getBranch = vi.fn((): SessionEntry[] => []);
		const options = {
			cwd: "/tmp",
			channel: "telegram",
			channelSessionId: "overlap-test",
			userMessageText: "continue",
			mainSessionManager: fakeSessionManager(getBranch) as unknown as SessionManager,
			modelRuntime: {} as unknown as ModelRuntime,
		};
		maybeRunConsolidation(options);
		maybeRunConsolidation(options);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getBranch).toHaveBeenCalledTimes(1);
	});
});
