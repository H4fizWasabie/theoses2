import { beforeEach, describe, expect, it, vi } from "vitest";

const askJevNouls = vi.hoisted(() => vi.fn());
vi.mock("../src/core/jev-client.ts", () => ({ askJevNouls }));

import { createDuplicateIndex, significantWordsAdded } from "../src/core/memory-dedup.ts";
import {
	activeNodes,
	createMemoryWriteGate,
	GATE_SAME_MIN_NOUL,
	isMemoryGateEnabled,
} from "../src/core/memory-gate.ts";
import type { MemoryNode } from "../src/core/memory-store.ts";

function node(id: string, subject: string, edges: MemoryNode["edges"] = []): MemoryNode {
	return { id, type: "semantic", subject, at: "2026-09-01T00:00:00.000Z", edges };
}

const stored = "The user is abah (Hafiz), creator of Theoses";
const reworded = "Hafiz is the creator of Theoses and should be addressed as 'abah'";

describe("createDuplicateIndex.findCandidates", () => {
	it("returns likely restatements, most similar first, and never a node with different numbers or negations", () => {
		const index = createDuplicateIndex([
			node("close", stored),
			node("far", "The portfolio site is served by Caddy from apps web dist"),
			node("port", "API port 8085 is allocated for the portfolio backend"),
		]);

		expect(index.findCandidates(reworded).map((n) => n.id)).toEqual(["close"]);
		expect(index.findCandidates("API port 8082 is allocated for the portfolio backend")).toEqual([]);
	});

	it("respects the limit and returns nothing for a subject with too few meaningful words", () => {
		const index = createDuplicateIndex([
			node("a", stored),
			node("b", "Hafiz is the creator of Theoses and addressed as abah"),
		]);

		expect(index.findCandidates(reworded, 1)).toHaveLength(1);
		expect(index.findCandidates("creator of Theoses")).toEqual([]);
	});
});

describe("significantWordsAdded", () => {
	it("counts the meaningful words the new text has that the old one lacks", () => {
		expect(significantWordsAdded(reworded, stored)).toBe(2);
		expect(significantWordsAdded(stored, stored)).toBe(0);
	});
});

describe("memory write gate", () => {
	beforeEach(() => askJevNouls.mockReset());

	it("reuses a stored node that already says everything, without asking Jev", async () => {
		const gate = createMemoryWriteGate([
			node(
				"old",
				"The delta landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
			),
		]);

		const verdict = await gate.check(
			"The landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
		);

		expect(verdict).toMatchObject({ action: "reuse", existing: { id: "old" } });
		expect(askJevNouls).not.toHaveBeenCalled();
	});

	it("stores a fact with no candidate, without asking Jev", async () => {
		const gate = createMemoryWriteGate([node("old", "The portfolio site is served by Caddy from apps web dist")]);

		expect(await gate.check(reworded)).toEqual({ action: "store" });
		expect(askJevNouls).not.toHaveBeenCalled();
	});

	it("reuses the stored node when Jev says it is the same fact and nothing is added", async () => {
		askJevNouls.mockResolvedValue({ c0: 0.95 });
		const gate = createMemoryWriteGate([node("old", stored)]);

		const verdict = await gate.check(reworded);

		expect(verdict).toMatchObject({ action: "reuse", existing: { id: "old" } });
		const [state, questions, options] = askJevNouls.mock.calls[0];
		expect(state).toEqual({ new: reworded, existing: { c0: stored } });
		expect(questions.c0).toBe("Do `new` and `existing.c0` state the same fact?");
		expect(options.timeoutMs).toBe(4000);
	});

	it("chooses the best-scoring of several candidates", async () => {
		askJevNouls.mockResolvedValue({ c0: 0.3, c1: 0.97 });
		const gate = createMemoryWriteGate([
			node("first", "Hafiz is the creator of Theoses and abah is how he wants to be addressed daily"),
			node("second", stored),
		]);

		const verdict = await gate.check(reworded);

		// Candidates are sent most similar first, so `stored` is c0 and the 0.97 belongs to "first".
		expect(askJevNouls.mock.calls[0][0].existing).toEqual({
			c0: stored,
			c1: "Hafiz is the creator of Theoses and abah is how he wants to be addressed daily",
		});
		expect(verdict).toMatchObject({ action: "reuse", existing: { id: "first" } });
	});

	it("stores it when Jev does not think it is the same fact", async () => {
		askJevNouls.mockResolvedValue({ c0: GATE_SAME_MIN_NOUL - 0.01 });

		expect(await createMemoryWriteGate([node("old", stored)]).check(reworded)).toEqual({ action: "store" });
	});

	it("stores it when Jev fails (fail open)", async () => {
		askJevNouls.mockResolvedValue(undefined);

		expect(await createMemoryWriteGate([node("old", stored)]).check(reworded)).toEqual({ action: "store" });
	});

	it("writes the new text and supersedes the old one when it is the same fact with real added detail", async () => {
		askJevNouls.mockResolvedValue({ c0: 0.93 });
		const gate = createMemoryWriteGate([node("old", "Abah's name is Hafiz, the creator of Theoses")]);

		const verdict = await gate.check(
			"Abah's name is Hafiz, the creator of Theoses, and he prefers being addressed as abah",
		);

		expect(verdict).toMatchObject({ action: "supersede", existing: { id: "old" } });
	});

	it("ignores nodes that are already hidden by a supersedes edge", async () => {
		const nodes = [
			node("hidden", stored),
			node("newer", "Hafiz created Theoses and is called abah in every chat", [
				{ target: "hidden", rel: "supersedes" },
			]),
		];

		expect(activeNodes(nodes).map((n) => n.id)).toEqual(["newer"]);
		askJevNouls.mockResolvedValue({ c0: 0.99 });
		const verdict = await createMemoryWriteGate(nodes).check(reworded);
		if (verdict.action !== "store") expect(verdict.existing.id).not.toBe("hidden");
	});

	it("never treats a changed number or a negated claim as a candidate", async () => {
		const gate = createMemoryWriteGate([
			node("port", "API port 8085 is allocated for the portfolio backend"),
			node("free", "The explorer agent uses the free model for exploration tasks"),
		]);

		expect(await gate.check("API port 8082 is allocated for the portfolio backend")).toEqual({ action: "store" });
		expect(await gate.check("The explorer agent does not use the free model for exploration tasks")).toEqual({
			action: "store",
		});
		expect(askJevNouls).not.toHaveBeenCalled();
	});

	it("checks later facts in the same batch against the ones just written", async () => {
		askJevNouls.mockResolvedValue({ c0: 0.95 });
		const gate = createMemoryWriteGate([]);

		expect(await gate.check(stored)).toEqual({ action: "store" });
		gate.noteStored(node("just-written", stored));

		expect(await gate.check(reworded)).toMatchObject({ action: "reuse", existing: { id: "just-written" } });
	});

	it("keeps only the network-free check when Jev is switched off", async () => {
		const gate = createMemoryWriteGate([node("old", stored)], { jev: false });

		expect(await gate.check(reworded)).toEqual({ action: "store" });
		expect(askJevNouls).not.toHaveBeenCalled();
	});
});

describe("isMemoryGateEnabled", () => {
	it("is on by default and off only for THEOSES_MEMORY_GATE=off", () => {
		expect(isMemoryGateEnabled({})).toBe(true);
		expect(isMemoryGateEnabled({ THEOSES_MEMORY_GATE: "on" })).toBe(true);
		expect(isMemoryGateEnabled({ THEOSES_MEMORY_GATE: "off" })).toBe(false);
	});
});
