import { describe, expect, it } from "vitest";
import {
	areDuplicateSubjects,
	createDuplicateIndex,
	normalizeSubject,
	planMemoryDedup,
} from "../src/core/memory-dedup.ts";
import type { MemoryEdge, MemoryNode } from "../src/core/memory-store.ts";

function node(id: string, subject: string, at = "2026-09-01T00:00:00.000Z", edges: MemoryEdge[] = []): MemoryNode {
	return { id, type: "semantic", subject, at, edges };
}

describe("areDuplicateSubjects", () => {
	it("matches subjects that differ only in case and punctuation", () => {
		expect(
			areDuplicateSubjects(
				"The user is Hafiz, the creator of Theoses.",
				"the user is hafiz - the creator of theoses",
			),
		).toBe(true);
	});

	it("matches a restatement that changes a word or two in a long subject", () => {
		expect(
			areDuplicateSubjects(
				"The user's name is Hafiz, the creator of Theoses, and must be addressed as 'abah'.",
				"The user's name is Hafiz, the creator of Theoses, and he must be addressed as 'abah'.",
			),
		).toBe(true);
		expect(
			areDuplicateSubjects(
				"Patched the Telegram formatting module to fix table rendering bugs",
				"Theoses patched the Telegram formatting module to fix table rendering bugs",
			),
		).toBe(true);
	});

	it("does not merge a fact whose number changed", () => {
		expect(
			areDuplicateSubjects(
				"PIMS runs behind Caddy with automatic HTTPS for the wasabietech domain on port 8083",
				"PIMS runs behind Caddy with automatic HTTPS for the wasabietech domain on port 8082",
			),
		).toBe(false);
	});

	it("does not merge when a short digit word differs, even though short words are ignored for overlap", () => {
		expect(
			areDuplicateSubjects(
				"The daily news workspace posts to the Facebook page at 13 hours every single day",
				"The daily news workspace posts to the Facebook page at 14 hours every single day",
			),
		).toBe(false);
		expect(
			areDuplicateSubjects(
				"Theoses now uses the DeepSeek v4 model for background consolidation and summaries",
				"Theoses now uses the DeepSeek v5 model for background consolidation and summaries",
			),
		).toBe(false);
	});

	it("does not merge a fact whose meaning flipped through a negation", () => {
		expect(
			areDuplicateSubjects(
				"The staging dashboard service is enabled and restarted manually after every release",
				"The staging dashboard service is not enabled and restarted manually after every release",
			),
		).toBe(false);
		expect(
			areDuplicateSubjects(
				"Prefetching the model catalog is disabled during startup for the telegram service",
				"Prefetching the model catalog is enabled during startup for the telegram service",
			),
		).toBe(false);
	});

	it("only merges short subjects when they are identical after normalising", () => {
		expect(areDuplicateSubjects("User prefers Go", "user prefers go.")).toBe(true);
		expect(areDuplicateSubjects("User prefers Go", "User prefers Rust")).toBe(false);
		expect(areDuplicateSubjects("Abah uses Brave browser", "Abah uses Chrome browser")).toBe(false);
	});

	it("keeps different facts apart even when they share most of their topic words", () => {
		expect(
			areDuplicateSubjects(
				"The Procura extension was built and tested on 2026-09-09 at the VPS with the staging service",
				"The Procura extension was deployed to production on 2026-09-11 at the VPS after review",
			),
		).toBe(false);
	});

	it("never matches an empty subject", () => {
		expect(areDuplicateSubjects("", "")).toBe(false);
		expect(areDuplicateSubjects("  ...  ", "!!!")).toBe(false);
	});
});

describe("createDuplicateIndex", () => {
	const landing = node(
		"landing",
		"The landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
	);

	it("finds a stored node by an exact normalised subject and by a near restatement", () => {
		const index = createDuplicateIndex([landing]);

		expect(
			index.find("the landing page s procura and pims cards now link to both their case study pages and live apps")
				?.id,
		).toBe("landing");
		expect(
			index.find("The landing page's Procura and PIMS cards link to both their case-study pages and the live apps.")
				?.id,
		).toBe("landing");
		expect(index.find("Something else entirely about the VPS swapfile and build memory")).toBeUndefined();
	});

	it("findRestatement only matches a stored node that already says everything the subject does", () => {
		const index = createDuplicateIndex([landing]);
		const moreSpecific =
			"The delta landing page's Procura and PIMS cards now link to both their case-study pages and live apps.";

		// The subject adds "delta", so reusing the stored node would lose it: a symmetric match, not a restatement.
		expect(index.find(moreSpecific)?.id).toBe("landing");
		expect(index.findRestatement(moreSpecific)).toBeUndefined();

		// The reverse: the stored node is the more specific one, so a less specific subject is a pure restatement.
		const specificStored = createDuplicateIndex([node("delta", moreSpecific)]);
		expect(specificStored.findRestatement(landing.subject)?.id).toBe("delta");
	});

	it("prefers the earliest stored node when several are equally good", () => {
		const first = node(
			"a-first",
			"Procura deployment runs on the VPS behind Caddy with HTTPS enabled",
			"2026-09-01T00:00:00.000Z",
		);
		const second = node(
			"b-second",
			"Procura deployment runs on the VPS behind Caddy with HTTPS enabled.",
			"2026-09-05T00:00:00.000Z",
		);

		expect(
			createDuplicateIndex([second, first]).find(
				"procura deployment runs on the vps behind caddy with https enabled",
			)?.id,
		).toBe("a-first");
	});

	it("matches nodes added after it was built, so duplicates within one response are caught", () => {
		const index = createDuplicateIndex();
		expect(index.find("Abah wants the memory graph to render quickly on thousands of nodes")).toBeUndefined();

		index.add(node("n1", "Abah wants the memory graph to render quickly on thousands of nodes"));

		expect(index.find("abah wants the memory graph to render quickly on thousands of nodes.")?.id).toBe("n1");
	});

	it("finds matches among thousands of nodes quickly", () => {
		const nodes = Array.from({ length: 8000 }, (_, i) =>
			node(
				`n${i}`,
				`Fact ${i} about topic ${i % 97} concerning subsystem ${i % 31} and component ${i % 13} maintenance`,
			),
		);
		const started = performance.now();
		const index = createDuplicateIndex(nodes);
		for (let i = 0; i < 300; i++)
			index.find(
				`Fact ${i * 7} about topic ${(i * 7) % 97} concerning subsystem ${(i * 7) % 31} and component ${(i * 7) % 13} maintenance.`,
			);
		const elapsed = performance.now() - started;

		expect(index.find(nodes[123].subject)?.id).toBe("n123");
		expect(elapsed).toBeLessThan(1500);
	});
});

describe("normalizeSubject", () => {
	it("lowercases and collapses punctuation and whitespace", () => {
		expect(normalizeSubject("  Hello, WORLD!!  it's -- fine ")).toBe("hello world it s fine");
	});
});

describe("planMemoryDedup", () => {
	it("keeps the earliest node of a group and lists the later restatements", () => {
		const plan = planMemoryDedup([
			node(
				"late",
				"The user is Hafiz, the creator of Theoses, and must be addressed as abah.",
				"2026-09-13T00:00:00.000Z",
			),
			node(
				"early",
				"The user is Hafiz, the creator of Theoses, and must be addressed as 'abah'.",
				"2026-09-11T00:00:00.000Z",
			),
			node(
				"middle",
				"The user is Hafiz the creator of Theoses and must be addressed as abah",
				"2026-09-12T00:00:00.000Z",
			),
			node(
				"other",
				"Something unrelated about the swapfile on the VPS being 5.3 GB in size",
				"2026-09-12T00:00:00.000Z",
			),
		]);

		expect(plan.nodeCount).toBe(4);
		expect(plan.duplicateGroups).toHaveLength(1);
		expect(plan.duplicateGroups[0].keep.id).toBe("early");
		expect(plan.duplicateGroups[0].remove.map((r) => r.id)).toEqual(["middle", "late"]);
		expect(plan.totals).toMatchObject({ duplicateNodes: 2, supersededNodes: 0, removableNodes: 2 });
	});

	it("marks a removal that adds words the kept node lacks, so it can be reviewed", () => {
		const plan = planMemoryDedup([
			node(
				"kept",
				"The landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
				"2026-09-01T00:00:00.000Z",
			),
			node(
				"specific",
				"The delta landing page's Procura and PIMS cards now link to both their case-study pages and live apps.",
				"2026-09-02T00:00:00.000Z",
			),
			node(
				"pure",
				"The landing page's Procura and PIMS cards link to both their case-study pages and live apps.",
				"2026-09-03T00:00:00.000Z",
			),
		]);

		const removals = plan.duplicateGroups[0].remove;
		expect(removals.find((r) => r.id === "specific")?.adds).toEqual(["delta"]);
		expect(removals.find((r) => r.id === "pure")?.adds).toEqual([]);
		expect(plan.totals.duplicatesAddingWords).toBe(1);
	});

	it("reports superseded nodes separately and counts a node that is both only once", () => {
		const plan = planMemoryDedup([
			node(
				"old-fact",
				"Prod runs the Telegram service on version one of the release pipeline",
				"2026-09-01T00:00:00.000Z",
			),
			node(
				"new-fact",
				"Prod runs the Telegram service on version two of the release pipeline",
				"2026-09-05T00:00:00.000Z",
				[{ target: "old-fact", rel: "supersedes" }],
			),
			node(
				"dup-of-old",
				"Prod runs the Telegram service on version one of the release pipeline.",
				"2026-09-06T00:00:00.000Z",
				[{ target: "missing", rel: "supersedes" }],
			),
		]);

		expect(plan.superseded.map((s) => s.id)).toEqual(["old-fact"]);
		expect(plan.superseded[0].supersededBy).toEqual(["new-fact"]);
		// "old-fact" is superseded and is also the kept original of a duplicate group; "dup-of-old" is a duplicate.
		expect(plan.totals).toMatchObject({ duplicateNodes: 1, supersededNodes: 1, removableNodes: 2 });
		// A supersedes edge to a node that does not exist is ignored.
		expect(plan.superseded.some((s) => s.id === "missing")).toBe(false);
	});

	it("does not modify the nodes it is given", () => {
		const nodes = [
			node("a", "The same long fact stated once in this exact wording for the test"),
			node("b", "The same long fact stated once in this exact wording for the test."),
		];
		const before = JSON.stringify(nodes);

		planMemoryDedup(nodes);

		expect(JSON.stringify(nodes)).toBe(before);
	});

	it("returns an empty plan for an empty store", () => {
		expect(planMemoryDedup([])).toEqual({
			nodeCount: 0,
			duplicateGroups: [],
			superseded: [],
			totals: { duplicateNodes: 0, duplicatesAddingWords: 0, supersededNodes: 0, removableNodes: 0 },
		});
	});
});
