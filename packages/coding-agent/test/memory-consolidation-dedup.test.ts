import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodicStore } from "../src/core/episodic-store.ts";
import { applyConsolidationResult, type ParsedConsolidation } from "../src/core/memory-consolidation.ts";
import { FileMemoryStore } from "../src/core/memory-store.ts";

// The edge-relation cross-check calls the Jev service; keep the test off the network.
vi.mock("../src/core/jev-client.ts", () => ({
	askJevChoice: vi.fn(async () => undefined),
	askJevNoul: vi.fn(async () => undefined),
}));

const EPISODE = {
	summary: "Something happened",
	startedAt: "2026-09-19T00:00:00.000Z",
	endedAt: "2026-09-19T01:00:00.000Z",
};

describe("applyConsolidationResult does not write a fact the store already has", () => {
	let dir: string;
	let store: FileMemoryStore;
	let recordEpisode: ReturnType<typeof vi.fn>;
	let episodic: EpisodicStore;

	beforeEach(() => {
		dir = join(tmpdir(), `theoses-consolidation-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		store = new FileMemoryStore(dir);
		recordEpisode = vi.fn();
		episodic = { recordEpisode } as unknown as EpisodicStore;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	const apply = (parsed: Partial<ParsedConsolidation>) =>
		applyConsolidationResult({ facts: [], edges: [], episode: EPISODE, ...parsed }, store, episodic);

	it("reuses the stored node for a restated fact and attaches edges and the episode to it", async () => {
		const stored = store.createNode({
			subject: "The user's name is Hafiz, the creator of Theoses, and must be addressed as 'abah'.",
		});
		const other = store.createNode({ subject: "Theoses runs on a Vultr VPS behind Caddy with automatic HTTPS" });

		await apply({
			facts: [{ id: "f1", subject: "The user is Hafiz, the creator of Theoses, and must be addressed as abah" }],
			edges: [{ from: "f1", to: other.id, rel: "depends_on" }],
			episode: { ...EPISODE, relatedFactIds: ["f1"] },
		});

		expect(store.listNodes()).toHaveLength(2);
		expect(store.getNode(stored.id)?.edges).toEqual([{ target: other.id, rel: "depends_on" }]);
		expect(recordEpisode).toHaveBeenCalledWith(expect.objectContaining({ relatedSemanticNodeIds: [stored.id] }));
	});

	it("writes a genuinely new fact", async () => {
		store.createNode({ subject: "Theoses runs on a Vultr VPS behind Caddy with automatic HTTPS" });

		await apply({
			facts: [{ id: "f1", subject: "The memory store holds about eight thousand nodes after the backfill" }],
		});

		expect(store.listNodes()).toHaveLength(2);
	});

	it("still writes a restatement that adds words, because it is a more specific fact", async () => {
		store.createNode({
			subject: "The landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
		});

		await apply({
			facts: [
				{
					id: "f1",
					subject:
						"The delta landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
				},
			],
		});

		expect(store.listNodes()).toHaveLength(2);
	});

	it("does not merge a fact whose number changed, so a supersedes edge can still point at the old one", async () => {
		const old = store.createNode({
			subject: "PIMS runs behind Caddy with automatic HTTPS for the wasabietech domain on port 8082",
		});

		await apply({
			facts: [
				{
					id: "f1",
					subject: "PIMS runs behind Caddy with automatic HTTPS for the wasabietech domain on port 8083",
				},
			],
			edges: [{ from: "f1", to: old.id, rel: "supersedes" }],
		});

		const nodes = store.listNodes();
		expect(nodes).toHaveLength(2);
		const created = nodes.find((n) => n.id !== old.id);
		expect(created?.edges).toEqual([{ target: old.id, rel: "supersedes" }]);
	});

	it("writes a fact stated twice in one response only once", async () => {
		await apply({
			facts: [
				{ id: "f1", subject: "Abah wants the memory graph dashboard to render quickly on thousands of nodes" },
				{ id: "f2", subject: "Abah wants the memory graph dashboard to render quickly on thousands of nodes." },
			],
			edges: [{ from: "f1", to: "f2", rel: "depends_on" }],
			episode: { ...EPISODE, relatedFactIds: ["f1", "f2"] },
		});

		const nodes = store.listNodes();
		expect(nodes).toHaveLength(1);
		// The two ids resolved to the same node, so the edge between them would be a self-edge and is skipped.
		expect(nodes[0].edges).toEqual([]);
		expect(recordEpisode).toHaveBeenCalledWith(
			expect.objectContaining({ relatedSemanticNodeIds: [nodes[0].id, nodes[0].id] }),
		);
	});

	it("adopts an elaboration the stored node lacks, and never overwrites one it has", async () => {
		const bare = store.createNode({
			subject: "The Procura extension was built and tested on 2026-09-09 at the VPS with staging",
		});
		const detailed = store.createNode({
			subject: "The dashboard memory graph now settles its layout and stops animating after about nine seconds",
			body: "Original detail.",
		});

		await apply({
			facts: [
				{
					id: "f1",
					subject: "The Procura extension was built and tested on 2026-09-09 at the VPS with staging.",
					body: "Elaboration from the restatement.",
				},
				{
					id: "f2",
					subject:
						"The dashboard memory graph now settles its layout and stops animating after about nine seconds.",
					body: "Should not replace.",
				},
			],
		});

		expect(store.getNode(bare.id)?.body).toBe("Elaboration from the restatement.");
		expect(store.getNode(detailed.id)?.body).toBe("Original detail.");
		expect(store.listNodes()).toHaveLength(2);
	});

	it("logs how many stored nodes it reused", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		store.createNode({
			subject: "The dashboard memory graph now settles its layout and stops animating after about nine seconds",
		});

		await apply({
			facts: [
				{
					id: "f1",
					subject:
						"The dashboard memory graph now settles its layout and stops animating after about nine seconds",
				},
			],
		});

		expect(log).toHaveBeenCalledWith(expect.stringContaining("[memory-dedup] reused 1 stored node(s)"));
	});
});
