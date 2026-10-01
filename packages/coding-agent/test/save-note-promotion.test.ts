import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/background-call.ts", () => ({ backgroundCall: vi.fn() }));
vi.mock("../src/core/jev-client.ts", () => ({
	askJevNoul: vi.fn(async () => undefined),
	askJevNouls: vi.fn(async () => undefined),
}));

import { ENV_AGENT_DIR, ENV_MEMORY_DIR } from "../src/config.ts";
import { backgroundCall } from "../src/core/background-call.ts";
import type { EpisodicStore } from "../src/core/episodic-store.ts";
import { askJevNoul } from "../src/core/jev-client.ts";
import { createMemoryPromotion, selectConsolidationWindow } from "../src/core/memory-promotion.ts";
import { FileMemoryStore } from "../src/core/memory-store.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const EDITOR = "The preferred editor is Vim";
const ROUTER = "The router address is 192.0.2.1";

// Issue #477: exercise AgentSession's actual registered save_note, not a tool factory with the
// notification callback omitted. Omitting that callback would also pass against the broken wiring.
describe("save_note leaves other facts eligible for promotion", () => {
	let dir: string;
	let harness: Harness;
	let store: FileMemoryStore;
	let recordEpisode: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "theoses-partial-save-"));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv(ENV_MEMORY_DIR, join(dir, "memories"));
		vi.stubEnv("THEOSES_CONSOLIDATION_CHECKPOINTS", join(dir, "checkpoints.json"));
		vi.mocked(backgroundCall).mockReset();
		vi.mocked(askJevNoul).mockReset();
		recordEpisode = vi.fn();
		harness = await createHarness({
			responses: [{ toolCalls: [{ name: "save_note", args: { note: EDITOR } }] }, "Saved the editor preference."],
		});
		// Harness sessions otherwise share the CLI cwd key; a failure cooldown must not leak across tests.
		vi.spyOn(harness.sessionManager, "getChannelSessionKey").mockReturnValue({
			channel: "cli",
			channelSessionId: dir,
		});
		store = new FileMemoryStore(join(dir, "memories"));
	});

	afterEach(() => {
		harness?.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function saveEditor() {
		await harness.session.prompt(`${EDITOR}. ${ROUTER}.`);
		expect(harness.eventsOfType("tool_execution_end")).toEqual(
			expect.arrayContaining([expect.objectContaining({ toolName: "save_note", isError: false })]),
		);
		expect(store.listNodes().map((node) => node.subject)).toEqual([EDITOR]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "promoted_range")).toEqual([]);
		const window = selectConsolidationWindow(harness.sessionManager.getBranch());
		expect(window.some((entry) => entry.message.role === "user")).toBe(true);
		expect(JSON.stringify(window)).toContain(ROUTER);
	}

	function makePromotion() {
		return createMemoryPromotion({
			sessionManager: harness.sessionManager,
			modelRuntime: harness.session.modelRuntime,
			memoryStore: store,
			episodicStore: { recordEpisode } as unknown as EpisodicStore,
		});
	}

	function trigger(path: "compaction" | "settlement", promotion: ReturnType<typeof makePromotion>) {
		if (path === "compaction") {
			promotion.promoteDropped(harness.sessionManager.getBranch().map((entry) => entry.id));
		} else {
			vi.mocked(askJevNoul).mockResolvedValue(0.95);
			promotion.settle("thanks, that's all");
		}
	}

	it.each(["compaction", "settlement"] as const)(
		"%s extracts the unsaved fact and reuses the explicit note before marking completion",
		async (path) => {
			await saveEditor();
			const savedId = store.listNodes()[0].id;
			vi.mocked(backgroundCall).mockResolvedValue({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							facts: [
								{ id: "editor", subject: EDITOR },
								{ id: "router", subject: ROUTER },
							],
							edges: [{ from: "editor", to: "router", rel: "depends_on" }],
							episode: {
								summary: "Recorded editor and router preferences",
								startedAt: "2026-10-01T00:00:00.000Z",
								endedAt: "2026-10-01T00:01:00.000Z",
								relatedFactIds: ["editor", "router"],
							},
						}),
					},
				],
			} as unknown as Awaited<ReturnType<typeof backgroundCall>>);
			const promotion = makePromotion();
			trigger(path, promotion);
			await vi.waitFor(() =>
				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "promoted_range")).toHaveLength(
					1,
				),
			);

			expect(backgroundCall).toHaveBeenCalledTimes(1);
			expect(vi.mocked(backgroundCall).mock.calls[0][1].prompt).toContain(ROUTER);
			expect(
				store
					.listNodes()
					.map((node) => node.subject)
					.sort(),
			).toEqual([EDITOR, ROUTER].sort());
			expect(store.getNode(savedId)?.subject).toBe(EDITOR);
			const routerId = store.listNodes().find((node) => node.subject === ROUTER)?.id;
			expect(store.getNode(savedId)?.edges).toEqual([{ target: routerId, rel: "depends_on" }]);
			expect(recordEpisode).toHaveBeenCalledWith(
				expect.objectContaining({ relatedSemanticNodeIds: [savedId, routerId] }),
			);
			expect(selectConsolidationWindow(harness.sessionManager.getBranch())).toEqual([]);

			// Completed ranges still prevent either trigger from processing this turn again.
			trigger("compaction", promotion);
			trigger("settlement", promotion);
			expect(backgroundCall).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["compaction", "settlement"] as const)("failed %s keeps the unsaved fact eligible", async (path) => {
		await saveEditor();
		vi.mocked(backgroundCall).mockRejectedValue(new Error("provider down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		trigger(path, makePromotion());
		await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("failed"), "provider down"));

		expect(store.listNodes().map((node) => node.subject)).toEqual([EDITOR]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "promoted_range")).toEqual([]);
		expect(JSON.stringify(selectConsolidationWindow(harness.sessionManager.getBranch()))).toContain(ROUTER);
	});
});
