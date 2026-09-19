import { beforeEach, describe, expect, it, vi } from "vitest";

const askJevNouls = vi.hoisted(() => vi.fn());
vi.mock("../src/core/jev-client.ts", () => ({ askJevNouls }));

import { isRememberRelevanceEnabled, RELEVANCE_MIN_NOUL, rankByRelevance } from "../src/core/memory-relevance.ts";
import type { MemoryRecord } from "../src/core/memory-store.ts";

function records(count: number): MemoryRecord[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `node-${i}`,
		createdAt: "2026-09-19T00:00:00Z",
		text: `fact ${i}`,
	}));
}

function scores(values: number[]): Record<string, number> {
	return Object.fromEntries(values.map((value, i) => [`n${i}`, value]));
}

describe("rankByRelevance", () => {
	beforeEach(() => askJevNouls.mockReset());

	it("orders by Jev's score, best first, and drops candidates under the floor", async () => {
		askJevNouls.mockResolvedValue(scores([0.2, 0.9, 0.5, RELEVANCE_MIN_NOUL]));

		const ranked = await rankByRelevance("query", records(4));

		expect(ranked?.map((r) => r.id)).toEqual(["node-1", "node-2", "node-3"]);
	});

	it("keeps the keyword order between candidates with the same score", async () => {
		askJevNouls.mockResolvedValue(scores([0.7, 0.7, 0.9, 0.7]));

		const ranked = await rankByRelevance("query", records(4));

		expect(ranked?.map((r) => r.id)).toEqual(["node-2", "node-0", "node-1", "node-3"]);
	});

	it("returns at most `limit` records", async () => {
		askJevNouls.mockResolvedValue(scores([0.9, 0.8, 0.7, 0.6, 0.5]));

		expect(await rankByRelevance("query", records(5), 2)).toHaveLength(2);
		expect(await rankByRelevance("query", records(5))).toHaveLength(5);
	});

	it("asks one atomic question per candidate about the subject of the query, with a short timeout", async () => {
		askJevNouls.mockResolvedValue(scores([0.9, 0.9]));
		const recs = records(2);
		recs[1].text = "x".repeat(1000);

		await rankByRelevance("who is the user", recs);

		const [state, questions, options] = askJevNouls.mock.calls[0];
		expect(state.query).toBe("who is the user");
		expect(state.nodes.n0).toBe("fact 0");
		expect(state.nodes.n1).toHaveLength(420);
		expect(Object.keys(questions)).toEqual(["n0", "n1"]);
		expect(questions.n1).toBe("Is `nodes.n1` about the subject of `query`?");
		expect(options.timeoutMs).toBe(4000);
	});

	it("returns undefined, so the caller falls back, when Jev fails", async () => {
		askJevNouls.mockResolvedValue(undefined);

		expect(await rankByRelevance("query", records(3))).toBeUndefined();
	});

	it("returns undefined when no candidate reaches the floor", async () => {
		askJevNouls.mockResolvedValue(scores([0.1, 0.2, 0.39]));

		expect(await rankByRelevance("query", records(3))).toBeUndefined();
	});

	it("does not call Jev when there is nothing to rank", async () => {
		expect(await rankByRelevance("query", [])).toBeUndefined();
		expect(askJevNouls).not.toHaveBeenCalled();
	});
});

describe("isRememberRelevanceEnabled", () => {
	it("is on by default and off only for THEOSES_REMEMBER_RELEVANCE=off", () => {
		expect(isRememberRelevanceEnabled({})).toBe(true);
		expect(isRememberRelevanceEnabled({ THEOSES_REMEMBER_RELEVANCE: "on" })).toBe(true);
		expect(isRememberRelevanceEnabled({ THEOSES_REMEMBER_RELEVANCE: "off" })).toBe(false);
	});
});
