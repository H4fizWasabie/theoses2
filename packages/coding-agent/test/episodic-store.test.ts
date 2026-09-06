import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpisodicStore } from "../src/core/episodic-store.ts";

describe("EpisodicStore", () => {
	let dir: string;
	let dbPath: string;
	let store: EpisodicStore;

	beforeEach(async () => {
		dir = join(tmpdir(), `theoses-episodic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		dbPath = join(dir, "episodes.db");
		store = await EpisodicStore.create(dbPath);
	});

	afterEach(() => {
		store.close();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("records an episode with a related semantic node id", () => {
		const record = store.recordEpisode({
			startedAt: "2026-09-03T05:00:00.000Z",
			endedAt: "2026-09-03T05:40:00.000Z",
			summary: "Built the ICM workspace",
			relatedSemanticNodeIds: ["icm_workspace_abc123"],
		});
		expect(record.relatedSemanticNodeIds).toEqual(["icm_workspace_abc123"]);
	});

	it("search matches keywords in the summary", () => {
		store.recordEpisode({
			startedAt: "2026-09-03T05:00:00.000Z",
			endedAt: "2026-09-03T05:10:00.000Z",
			summary: "Fixed the VPS firewall configuration",
		});
		store.recordEpisode({
			startedAt: "2026-09-03T06:00:00.000Z",
			endedAt: "2026-09-03T06:10:00.000Z",
			summary: "Researched news about AI models",
		});
		const results = store.search("firewall");
		expect(results).toHaveLength(1);
		expect(results[0]?.summary).toContain("firewall");
	});

	it("search matches significant terms from a natural-language query", () => {
		store.recordEpisode({
			startedAt: "2026-09-03T05:00:00.000Z",
			endedAt: "2026-09-03T05:10:00.000Z",
			summary: "Fixed the VPS firewall configuration",
		});

		expect(store.search("what do you know about the firewall").map((r) => r.summary)).toEqual([
			"Fixed the VPS firewall configuration",
		]);
	});

	it("atTime returns episodes whose range contains the timestamp", () => {
		store.recordEpisode({
			startedAt: "2026-09-03T05:00:00.000Z",
			endedAt: "2026-09-03T05:40:00.000Z",
			summary: "Window A",
		});
		const results = store.atTime("2026-09-03T05:20:00.000Z");
		expect(results.map((r) => r.summary)).toContain("Window A");
	});

	it("recent returns episodes most-recent-first", () => {
		store.recordEpisode({
			startedAt: "2026-09-03T05:00:00.000Z",
			endedAt: "2026-09-03T05:10:00.000Z",
			summary: "First",
		});
		store.recordEpisode({
			startedAt: "2026-09-03T06:00:00.000Z",
			endedAt: "2026-09-03T06:10:00.000Z",
			summary: "Second",
		});
		const results = store.recent();
		expect(results.map((r) => r.summary)).toEqual(["Second", "First"]);
	});
});
