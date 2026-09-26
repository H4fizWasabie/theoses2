import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/background-call.ts", () => ({ backgroundCall: vi.fn() }));
vi.mock("../src/core/jev-client.ts", () => ({
	askJevChoice: vi.fn(async () => undefined),
	askJevNoul: vi.fn(async () => undefined),
	askJevNouls: vi.fn(async () => undefined),
}));

import { backgroundCall } from "../src/core/background-call.ts";
import type { EpisodicStore } from "../src/core/episodic-store.ts";
import { askJevNoul } from "../src/core/jev-client.ts";
import { createMemoryPromotion, selectConsolidationWindow } from "../src/core/memory-promotion.ts";
import { FileMemoryStore } from "../src/core/memory-store.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const flush = async (times = 3) => {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A successful consolidation response: one fact, no edges, one episode. */
function fauxConsolidationResponse(fact = "a durable fact") {
	return {
		stopReason: "stop",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					facts: [{ id: "f1", subject: fact }],
					edges: [],
					episode: {
						summary: "chatted",
						startedAt: "2026-09-20T00:00:00.000Z",
						endedAt: "2026-09-20T00:01:00.000Z",
					},
				}),
			},
		],
	} as unknown as Awaited<ReturnType<typeof backgroundCall>>;
}

describe("memory-promotion", () => {
	let dir: string;
	let memoryStore: FileMemoryStore;
	let recordEpisode: ReturnType<typeof vi.fn>;
	let episodicStore: EpisodicStore;
	let sessionManager: SessionManager;

	beforeEach(() => {
		dir = join(tmpdir(), `theoses-memory-promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		memoryStore = new FileMemoryStore(dir);
		recordEpisode = vi.fn();
		episodicStore = { recordEpisode } as unknown as EpisodicStore;
		// A distinct channelSessionId per test: promotion's in-flight set and failure cooldown are keyed on it
		// at module scope, so tests sharing one key would leak state (a cooldown set by one test blocking
		// another's assertions) across this file's shared module instance.
		sessionManager = SessionManager.inMemory(undefined, {
			channel: "telegram",
			channelSessionId: `promotion-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		});
		vi.mocked(backgroundCall).mockReset();
		vi.mocked(askJevNoul).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	function appendUserTurn(text: string): string {
		const id = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		return id;
	}

	function makePromotion() {
		return createMemoryPromotion({
			sessionManager,
			modelRuntime: {} as unknown as ModelRuntime,
			memoryStore,
			episodicStore,
		});
	}

	describe("unpromoted entries (selectConsolidationWindow)", () => {
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

	describe("promoteDropped (compaction) then settle (Turn Settlement)", () => {
		it("does not re-distill the same turns settlement already sees promoted", async () => {
			appendUserTurn("please remember this");
			vi.mocked(backgroundCall).mockResolvedValue(fauxConsolidationResponse());
			const promotion = makePromotion();

			const entryIds = sessionManager.getBranch().map((entry) => entry.id);
			promotion.promoteDropped(entryIds);
			await vi.waitFor(() => expect(backgroundCall).toHaveBeenCalledTimes(1));
			await flush();

			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			promotion.settle("thanks, that's all");
			await flush(10);

			expect(backgroundCall).toHaveBeenCalledTimes(1);
		});

		it("leaves entries unpromoted for settlement when a compaction distill fails", async () => {
			appendUserTurn("please remember this");
			vi.mocked(backgroundCall).mockRejectedValueOnce(new Error("provider down"));
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const promotion = makePromotion();

			const entryIds = sessionManager.getBranch().map((entry) => entry.id);
			promotion.promoteDropped(entryIds);
			await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

			expect(sessionManager.getBranch().some((entry) => entry.type === "promoted_range")).toBe(false);
		});

		it("skips a compaction pass while a settlement pass for the same key is in flight", async () => {
			appendUserTurn("please remember this");
			let releaseFirst: (() => void) | undefined;
			const firstCallGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			vi.mocked(backgroundCall).mockImplementationOnce(async () => {
				await firstCallGate;
				return fauxConsolidationResponse();
			});
			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			const promotion = makePromotion();

			promotion.settle("thanks, that's all");
			await vi.waitFor(() => expect(backgroundCall).toHaveBeenCalledTimes(1));

			const entryIds = sessionManager.getBranch().map((entry) => entry.id);
			promotion.promoteDropped(entryIds);
			await flush(5);
			expect(backgroundCall).toHaveBeenCalledTimes(1); // the compaction pass was skipped, not queued

			releaseFirst?.();
			await vi.waitFor(() =>
				expect(sessionManager.getBranch().some((entry) => entry.type === "promoted_range")).toBe(true),
			);
		});

		it("blocks both paths during the failure cooldown", async () => {
			appendUserTurn("please remember this");
			vi.mocked(backgroundCall).mockRejectedValueOnce(new Error("provider down"));
			vi.spyOn(console, "error").mockImplementation(() => {});
			const promotion = makePromotion();

			const entryIds = sessionManager.getBranch().map((entry) => entry.id);
			promotion.promoteDropped(entryIds);
			await vi.waitFor(() => expect(backgroundCall).toHaveBeenCalledTimes(1));

			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			promotion.settle("thanks, that's all");
			await flush(10);

			expect(backgroundCall).toHaveBeenCalledTimes(1); // still in cooldown, settlement did not retry
		});

		it("skips entries recordSaved already covered, for both compaction and settlement", async () => {
			appendUserTurn("please remember this");
			const promotion = makePromotion();
			promotion.recordSaved();

			vi.mocked(backgroundCall).mockResolvedValue(fauxConsolidationResponse());
			const entryIds = sessionManager.getBranch().map((entry) => entry.id);
			promotion.promoteDropped(entryIds);
			await flush(5);
			expect(backgroundCall).not.toHaveBeenCalled();

			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			promotion.settle("thanks, that's all");
			await flush(5);
			expect(backgroundCall).not.toHaveBeenCalled();
		});
	});

	describe("legacy checkpoint migration", () => {
		let checkpointDir: string;
		let checkpointPath: string;
		let previousEnv: string | undefined;

		beforeEach(() => {
			checkpointDir = mkdtempSync(join(tmpdir(), "theoses-consolidation-checkpoints-"));
			checkpointPath = join(checkpointDir, "consolidation-checkpoints.json");
			previousEnv = process.env.THEOSES_CONSOLIDATION_CHECKPOINTS;
			process.env.THEOSES_CONSOLIDATION_CHECKPOINTS = checkpointPath;
		});

		afterEach(() => {
			if (previousEnv === undefined) delete process.env.THEOSES_CONSOLIDATION_CHECKPOINTS;
			else process.env.THEOSES_CONSOLIDATION_CHECKPOINTS = previousEnv;
			rmSync(checkpointDir, { recursive: true, force: true });
		});

		it("moves a legacy checkpoint into the session log once, then deletes the file", async () => {
			appendUserTurn("first"); // e0 user, e1 assistant
			appendUserTurn("second"); // e2 user, e3 assistant
			const key = `${sessionManager.getChannelSessionKey().channel}:${sessionManager.getChannelSessionKey().channelSessionId}`;
			const branch = sessionManager.getBranch();
			writeFileSync(checkpointPath, JSON.stringify({ [key]: { lastEntryId: branch[1].id } }));

			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			vi.mocked(backgroundCall).mockResolvedValue(fauxConsolidationResponse());
			const promotion = makePromotion();
			promotion.settle("thanks, that's all");

			await vi.waitFor(() => expect(existsSync(checkpointPath)).toBe(false));
			const ranges = sessionManager
				.getBranch()
				.filter((entry) => entry.type === "promoted_range")
				.map((entry) => [entry.firstEntryId, entry.lastEntryId]);
			expect(ranges[0]).toEqual([branch[0].id, branch[1].id]);
		});

		it("migrates before a compaction pass, so turns the legacy checkpoint covered are not distilled again", async () => {
			appendUserTurn("first");
			appendUserTurn("second");
			const key = `${sessionManager.getChannelSessionKey().channel}:${sessionManager.getChannelSessionKey().channelSessionId}`;
			const branch = sessionManager.getBranch();
			writeFileSync(checkpointPath, JSON.stringify({ [key]: { lastEntryId: branch[3].id } }));

			vi.mocked(backgroundCall).mockResolvedValue(fauxConsolidationResponse());
			const promotion = makePromotion();
			promotion.promoteDropped(branch.map((entry) => entry.id));
			await flush(10);

			expect(existsSync(checkpointPath)).toBe(false);
			expect(backgroundCall).not.toHaveBeenCalled();
		});
	});
});
