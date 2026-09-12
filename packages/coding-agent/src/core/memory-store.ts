import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { getMemoriesDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";

/** Closed vocabulary for semantic-graph edges. Extend only on a real, recurring gap. */
export const EDGE_RELATIONS = [
	"prefers",
	"attributed_to",
	"depends_on",
	"located_at",
	"requires",
	"supersedes",
	"used_in",
	"maintains",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export interface MemoryEdge {
	target: string;
	rel: EdgeRelation;
}

export interface MemoryNode {
	id: string;
	/** Always "semantic" today — episodic memory lives in a separate SQLite store, not this graph. */
	type: "semantic";
	subject: string;
	at: string;
	edges: MemoryEdge[];
	body?: string;
}

/** Flat view of a node, for callers that only need id/timestamp/text (e.g. the `remember` tool's output). */
export interface MemoryRecord {
	id: string;
	createdAt: string;
	text: string;
}

export interface MemoryStore {
	remember(query: string): MemoryRecord[];
	saveNote(text: string): MemoryRecord;
}

/** Common English function words, stripped from `remember` queries so they don't dilute term matching. */
export const QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"am",
	"an",
	"and",
	"are",
	"do",
	"does",
	"did",
	"for",
	"he",
	"her",
	"him",
	"his",
	"how",
	"i",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"or",
	"our",
	"remember",
	"she",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"us",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"who",
	"why",
	"with",
	"you",
	"your",
]);

function defaultMemoryDir(): string {
	return getMemoriesDir();
}

function legacyMemoryFilePath(): string {
	return process.env.THEOSES_MEMORY_FILE ?? join(dirname(getMemoriesDir()), "memory.jsonl");
}

interface LegacyMemoryRecord {
	id?: string;
	createdAt?: string;
	text?: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TermMatcher {
	/** Significant terms extracted from the query, after stopword filtering. */
	terms: string[];
	/** Distinct-term-overlap score for a haystack: how many terms match, not how many times. */
	score(haystack: string): number;
}

/**
 * Builds a bounded keyword matcher from a free-text query, shared by `remember` (durable memory,
 * `MemoryNode` subject+body) and the session-turn lookback tool (`recall_turns.ts`, current
 * session's own conversational text) - same term-overlap approach, two different corpora. Kept
 * here rather than duplicated so both stay in sync as the matching heuristic evolves.
 *
 * Drops very short tokens ("i", "am") before matching: as bare substrings they match almost any
 * text (e.g. "i" inside "prefers"), which drowns out genuinely relevant hits once ranked by
 * term-overlap score. Falls back to all terms (not just significant ones) when a query is mostly
 * stopwords ("who am I", "what do you know about my preferences") - the natural-language question
 * this is meant to answer would otherwise match nothing.
 */
export function buildTermMatcher(query: string): TermMatcher {
	const allTerms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length >= 3);
	const significantTerms = allTerms.filter((term) => !QUERY_STOPWORDS.has(term));
	const terms = significantTerms.length > 0 ? significantTerms : allTerms;
	// Word-boundary matches so a term like "user" doesn't also count as a hit inside unrelated words.
	const termPatterns = terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`));
	return {
		terms,
		score(haystack: string): number {
			if (termPatterns.length === 0) return 0;
			const lower = haystack.toLowerCase();
			let score = 0;
			for (const pattern of termPatterns) if (pattern.test(lower)) score++;
			return score;
		},
	};
}

function slugify(subject: string): string {
	const base = subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
	return base || "note";
}

function nodeToRecord(node: MemoryNode): MemoryRecord {
	return { id: node.id, createdAt: node.at, text: node.subject };
}

interface NodeFrontmatter {
	id: string;
	type: "semantic";
	subject: string;
	at: string;
	edges: MemoryEdge[];
}

function serializeNode(node: MemoryNode): string {
	const frontmatter: NodeFrontmatter = {
		id: node.id,
		type: node.type,
		subject: node.subject,
		at: node.at,
		edges: node.edges,
	};
	return `---\n${stringify(frontmatter)}---\n${node.body ? `${node.body}\n` : ""}`;
}

function parseNode(raw: string): MemoryNode | undefined {
	const { frontmatter, body } = parseFrontmatter<Partial<NodeFrontmatter>>(raw);
	if (!frontmatter.id || !frontmatter.at || frontmatter.subject === undefined) return undefined;
	return {
		id: frontmatter.id,
		type: "semantic",
		subject: frontmatter.subject,
		at: frontmatter.at,
		edges: frontmatter.edges ?? [],
		body: body ? body : undefined,
	};
}

export class FileMemoryStore implements MemoryStore {
	private readonly dir: string;

	constructor(dir = defaultMemoryDir()) {
		this.dir = dir;
		this.migrateLegacyStore();
	}

	/**
	 * One-time migration from the old flat `memory.jsonl` (pre-graph) store: each line becomes a
	 * bare node, same as the live `save_note` path, preserving the original id/timestamp so it
	 * doesn't silently disappear on deploy. Only runs once — if this store's directory already
	 * exists, migration has already happened (or there was never anything to migrate).
	 */
	private migrateLegacyStore(): void {
		if (existsSync(this.dir)) return;
		const legacyPath = legacyMemoryFilePath();
		if (!existsSync(legacyPath)) return;
		const lines = readFileSync(legacyPath, "utf8").split("\n").filter(Boolean);
		if (lines.length === 0) return;
		mkdirSync(this.dir, { recursive: true });
		for (const line of lines) {
			try {
				const legacy = JSON.parse(line) as LegacyMemoryRecord;
				if (typeof legacy.text !== "string") continue;
				this.writeNode({
					id: legacy.id ?? randomUUID(),
					type: "semantic",
					subject: legacy.text,
					at: legacy.createdAt ?? new Date().toISOString(),
					edges: [],
				});
			} catch {
				// Skip malformed legacy lines rather than aborting the whole migration.
			}
		}
	}

	private nodePath(id: string): string {
		return join(this.dir, `${id}.md`);
	}

	/** All nodes currently on disk, malformed files silently skipped. */
	listNodes(): MemoryNode[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((name) => name.endsWith(".md"))
			.flatMap((name) => {
				const node = parseNode(readFileSync(join(this.dir, name), "utf8"));
				return node ? [node] : [];
			});
	}

	getNode(id: string): MemoryNode | undefined {
		const path = this.nodePath(id);
		if (!existsSync(path)) return undefined;
		return parseNode(readFileSync(path, "utf8"));
	}

	writeNode(node: MemoryNode): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(this.nodePath(node.id), serializeNode(node));
	}

	addEdge(nodeId: string, edge: MemoryEdge): void {
		const node = this.getNode(nodeId);
		if (!node) throw new Error(`Cannot add edge: node ${nodeId} not found`);
		if (node.edges.some((e) => e.target === edge.target && e.rel === edge.rel)) return;
		this.writeNode({ ...node, edges: [...node.edges, edge] });
	}

	/** Consolidation path: a full node with edges/body, id chosen by the caller (or generated here). */
	createNode(input: { id?: string; subject: string; at?: string; edges?: MemoryEdge[]; body?: string }): MemoryNode {
		const id = input.id ?? `${slugify(input.subject)}_${randomUUID().slice(0, 8)}`;
		const node: MemoryNode = {
			id,
			type: "semantic",
			subject: input.subject.trim(),
			at: input.at ?? new Date().toISOString(),
			edges: input.edges ?? [],
			body: input.body,
		};
		this.writeNode(node);
		return node;
	}

	/** Live path: a bare node, no edges, no dedup — the next consolidation pass backfills both. */
	saveNote(text: string): MemoryRecord {
		return nodeToRecord(this.createNode({ subject: text }));
	}

	/**
	 * Keyword entry-point match, then a 1-2 hop edge walk (both directions) from every match.
	 * Deterministic, zero-LLM-call floor — the graph enriches recall, never gates it.
	 * Nodes superseded by a newer node (i.e. targeted by another node's `supersedes` edge) are
	 * hidden by default; they stay reachable by explicit traversal, just not surfaced unprompted.
	 */
	remember(query: string): MemoryRecord[] {
		const nodes = this.listNodes();
		if (nodes.length === 0) return [];
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const superseded = new Set(
			nodes.flatMap((n) => n.edges.filter((e) => e.rel === "supersedes").map((e) => e.target)),
		);

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
				if (!depth.has(other.id) && other.edges.some((e) => e.target === id))
					queue.push({ id: other.id, d: d + 1 });
		}

		return [...depth.entries()]
			.map(([id, d]) => ({ node: byId.get(id), d, score: scores.get(id) ?? 0 }))
			.filter(
				(entry): entry is { node: MemoryNode; d: number; score: number } =>
					!!entry.node && !superseded.has(entry.node.id),
			)
			.sort((a, b) => a.d - b.d || b.score - a.score || b.node.at.localeCompare(a.node.at))
			.slice(0, 8)
			.map((entry) => nodeToRecord(entry.node));
	}
}
