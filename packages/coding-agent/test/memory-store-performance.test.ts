import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildTermMatcher,
	EDGE_RELATIONS,
	FileMemoryStore,
	type MemoryEdge,
	type MemoryNode,
	type MemoryRecord,
} from "../src/core/memory-store.ts";

/** Small deterministic PRNG so the randomized comparisons are reproducible. */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

/**
 * The recall algorithm as it was before the reverse-edge index and token-set scoring: one regex test
 * per query term per node, and a scan of every node for every visited node when walking edges
 * backwards. Kept here as the reference the optimized version must match exactly.
 */
function referenceRemember(nodes: MemoryNode[], query: string): MemoryRecord[] {
	if (nodes.length === 0) return [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const superseded = new Set(nodes.flatMap((n) => n.edges.filter((e) => e.rel === "supersedes").map((e) => e.target)));
	const matcher = buildTermMatcher(query);
	if (matcher.terms.length === 0) return [];
	const scoreOf = (n: MemoryNode): number => matcher.score(`${n.subject} ${n.body ?? ""}`);
	const scores = new Map(nodes.map((n) => [n.id, scoreOf(n)]));
	const entryIds = nodes.filter((n) => (scores.get(n.id) ?? 0) > 0).map((n) => n.id);
	if (entryIds.length === 0) return [];

	const depth = new Map<string, number>();
	const queue: Array<{ id: string; d: number }> = entryIds.map((id) => ({ id, d: 0 }));
	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		const { id, d } = item;
		if (depth.has(id)) continue;
		depth.set(id, d);
		if (d >= 2) continue;
		const node = byId.get(id);
		if (!node) continue;
		for (const edge of node.edges) if (!depth.has(edge.target)) queue.push({ id: edge.target, d: d + 1 });
		for (const other of nodes)
			if (!depth.has(other.id) && other.edges.some((e) => e.target === id)) queue.push({ id: other.id, d: d + 1 });
	}

	return [...depth.entries()]
		.map(([id, d]) => ({ node: byId.get(id), d, score: scores.get(id) ?? 0 }))
		.filter(
			(entry): entry is { node: MemoryNode; d: number; score: number } =>
				!!entry.node && !superseded.has(entry.node.id),
		)
		.sort((a, b) => a.d - b.d || b.score - a.score || b.node.at.localeCompare(a.node.at))
		.slice(0, 8)
		.map((entry) => ({ id: entry.node.id, createdAt: entry.node.at, text: entry.node.subject }));
}

describe("FileMemoryStore performance changes", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `theoses-memory-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	describe("remember matches the reference algorithm", () => {
		// Words chosen to exercise the matching rules: case, digits, underscores, punctuation, stopwords, substrings.
		const vocabulary = [
			"deploy",
			"Portfolio",
			"cache",
			"telegram",
			"typing",
			"user",
			"users",
			"foo_bar",
			"foo",
			"bar-baz",
			"v4",
			"gpt5",
			"prefers",
			"the",
			"about",
			"Dashboard",
			"memory",
			"graph",
			"CACHE",
			"e-mail",
		];

		function buildRandomStore(seed: number, nodeCount: number): FileMemoryStore {
			const random = seededRandom(seed);
			const store = new FileMemoryStore(dir);
			const ids = Array.from({ length: nodeCount }, (_, i) => `node_${seed}_${i}`);
			const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
			for (let i = 0; i < nodeCount; i++) {
				const words = Array.from({ length: 2 + Math.floor(random() * 5) }, () => pick(vocabulary));
				const edges: MemoryEdge[] = [];
				const edgeCount = Math.floor(random() * 4);
				for (let e = 0; e < edgeCount; e++) {
					const roll = random();
					// Mostly real targets; some self-edges, some dangling targets, some duplicated edges.
					const target = roll < 0.05 ? ids[i] : roll < 0.12 ? "missing_node" : pick(ids);
					const rel = pick([...EDGE_RELATIONS]);
					edges.push({ target, rel });
					if (random() < 0.15) edges.push({ target, rel: pick([...EDGE_RELATIONS]) });
				}
				store.createNode({
					id: ids[i],
					subject: words.join(" "),
					at: new Date(Date.UTC(2026, 8, 1 + Math.floor(random() * 15), Math.floor(random() * 24))).toISOString(),
					edges,
					body: random() < 0.5 ? `${pick(vocabulary)} ${pick(vocabulary)} details` : undefined,
				});
			}
			return store;
		}

		it("returns the same records in the same order over many random graphs and queries", () => {
			for (const seed of [1, 2, 3, 4]) {
				rmSync(dir, { recursive: true, force: true });
				mkdirSync(dir, { recursive: true });
				const store = buildRandomStore(seed, 120);
				const nodes = store.listNodes();
				const random = seededRandom(seed * 101);
				for (let q = 0; q < 60; q++) {
					const words = Array.from(
						{ length: 1 + Math.floor(random() * 6) },
						() => vocabulary[Math.floor(random() * vocabulary.length)],
					);
					const query = words.join(random() < 0.5 ? " " : ", ");
					expect(store.remember(query), `seed ${seed} query ${JSON.stringify(query)}`).toEqual(
						referenceRemember(nodes, query),
					);
				}
			}
		});

		it("counts a term repeated in the query once per repetition, like the regex scoring did", () => {
			const store = new FileMemoryStore(dir);
			store.createNode({ id: "a", subject: "deploy notes", at: "2026-09-01T00:00:00.000Z" });
			store.createNode({ id: "b", subject: "cache notes", at: "2026-09-02T00:00:00.000Z" });
			const nodes = store.listNodes();

			// "cache" is repeated, so it outweighs the single "deploy" and node b must rank first.
			const query = "deploy cache cache cache";
			expect(store.remember(query).map((r) => r.id)).toEqual(["b", "a"]);
			expect(store.remember(query)).toEqual(referenceRemember(nodes, query));
		});

		it("treats underscores as part of a word, so foo does not match foo_bar", () => {
			const store = new FileMemoryStore(dir);
			store.createNode({ id: "underscored", subject: "the foo_bar setting" });
			store.createNode({ id: "hyphenated", subject: "the foo-bar setting" });

			expect(store.remember("foo").map((r) => r.id)).toEqual(["hyphenated"]);
		});

		it("handles a transcript-sized query with thousands of terms", () => {
			const random = seededRandom(99);
			const store = buildRandomStore(9, 150);
			const nodes = store.listNodes();
			const query = Array.from({ length: 6000 }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(
				" ",
			);

			expect(store.remember(query)).toEqual(referenceRemember(nodes, query));
		});
	});

	describe("listNodes cache", () => {
		it("sees files added, removed and rewritten between calls", () => {
			const store = new FileMemoryStore(dir);
			const first = store.createNode({ id: "first", subject: "First fact" });
			store.createNode({ id: "second", subject: "Second fact" });
			expect(
				store
					.listNodes()
					.map((n) => n.id)
					.sort(),
			).toEqual(["first", "second"]);

			store.createNode({ id: "third", subject: "Third fact" });
			unlinkSync(join(dir, "second.md"));
			store.addEdge(first.id, { target: "third", rel: "used_in" });

			const nodes = new FileMemoryStore(dir).listNodes();
			expect(nodes.map((n) => n.id).sort()).toEqual(["first", "third"]);
			expect(nodes.find((n) => n.id === "first")?.edges).toEqual([{ target: "third", rel: "used_in" }]);
		});

		it("skips malformed files, and picks them up once they are fixed", () => {
			const store = new FileMemoryStore(dir);
			store.createNode({ id: "good", subject: "Good node" });
			writeFileSync(join(dir, "broken.md"), "not a node at all");
			expect(store.listNodes().map((n) => n.id)).toEqual(["good"]);

			writeFileSync(
				join(dir, "broken.md"),
				"---\nid: broken\ntype: semantic\nsubject: Now valid and a bit longer\nat: 2026-09-01T00:00:00.000Z\nedges: []\n---\n",
			);

			expect(
				store
					.listNodes()
					.map((n) => n.id)
					.sort(),
			).toEqual(["broken", "good"]);
		});

		it("reuses a parsed file while its mtime and size are unchanged", () => {
			const store = new FileMemoryStore(dir);
			store.createNode({ id: "cached", subject: "Original subject" });
			const path = join(dir, "cached.md");
			// Pin the mtime to a whole-millisecond value so it can be restored exactly after the rewrite.
			const pinned = new Date("2026-09-01T00:00:00.000Z");
			utimesSync(path, pinned, pinned);
			expect(store.listNodes()[0].subject).toBe("Original subject");

			// Same length and same mtime: the cache is trusted, which is the documented trade-off.
			writeFileSync(path, readFileSync(path, "utf8").replace("Original subject", "Replaced subject"));
			utimesSync(path, pinned, pinned);
			expect(statSync(path).mtimeMs).toBe(pinned.getTime());
			expect(store.listNodes()[0].subject).toBe("Original subject");

			// A new mtime is enough to invalidate it.
			const later = new Date(pinned.getTime() + 5000);
			utimesSync(path, later, later);
			expect(store.listNodes()[0].subject).toBe("Replaced subject");
		});

		it("keeps separate caches per directory", () => {
			const other = join(tmpdir(), `theoses-memory-perf-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(other, { recursive: true });
			try {
				new FileMemoryStore(dir).createNode({ id: "here", subject: "In the first directory" });
				new FileMemoryStore(other).createNode({ id: "there", subject: "In the other directory" });

				expect(new FileMemoryStore(dir).listNodes().map((n) => n.id)).toEqual(["here"]);
				expect(new FileMemoryStore(other).listNodes().map((n) => n.id)).toEqual(["there"]);
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		});

		it("shares parsed nodes between store instances instead of parsing again", () => {
			new FileMemoryStore(dir).createNode({ id: "shared", subject: "Shared node" });

			const a = new FileMemoryStore(dir).listNodes()[0];
			const b = new FileMemoryStore(dir).listNodes()[0];

			expect(b).toBe(a);
		});

		it("returns an empty list, and forgets the cache, when the directory is gone", () => {
			const store = new FileMemoryStore(dir);
			store.createNode({ id: "x", subject: "Soon gone" });
			expect(store.listNodes()).toHaveLength(1);

			rmSync(dir, { recursive: true, force: true });

			expect(store.listNodes()).toEqual([]);
		});
	});
});
