import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

/** Short description per relation, for surfaces (Jev Choice criteria today) that need to explain
 * the closed vocabulary rather than just list its labels. Keep in sync with EDGE_RELATIONS. */
export const EDGE_RELATION_DESCRIPTIONS: Record<EdgeRelation, string> = {
	prefers: "'from' expresses a preference for 'to' (a choice, a style, a tool)",
	attributed_to: "'from' is a statement, decision, or action made by 'to' (a person or team)",
	depends_on: "'from' requires 'to' to exist or function first (a technical or logical dependency)",
	located_at: "'from' is physically or organizationally located at 'to' (a place, host, or system)",
	requires: "'from' needs 'to' as a precondition or input, without 'to' being a dependency in the technical sense",
	supersedes: "'from' replaces or overrides an earlier fact, 'to', that is now outdated",
	used_in: "'from' is used as part of or within 'to'",
	maintains: "'from' is responsible for the upkeep or ownership of 'to'",
};

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
	// Built on first use: `remember` scores with token sets instead, and a transcript-sized query has
	// thousands of terms, so compiling a regex for each of them up front was wasted work.
	let termPatterns: RegExp[] | undefined;
	return {
		terms,
		score(haystack: string): number {
			if (terms.length === 0) return 0;
			termPatterns ??= terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`));
			const lower = haystack.toLowerCase();
			let score = 0;
			for (const pattern of termPatterns) if (pattern.test(lower)) score++;
			return score;
		},
	};
}

/** Lowercased word-character runs of a node's subject and body, computed once per parsed node. */
const nodeTokenSets = new WeakMap<MemoryNode, Set<string>>();

function tokensOf(node: MemoryNode): Set<string> {
	let tokens = nodeTokenSets.get(node);
	if (!tokens) {
		tokens = new Set(`${node.subject} ${node.body ?? ""}`.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
		nodeTokenSets.set(node, tokens);
	}
	return tokens;
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

interface CachedNodeFile {
	mtimeMs: number;
	size: number;
	/** null for a file that exists but is not a valid node, so it is not re-parsed on every listing. */
	node: MemoryNode | null;
}

/**
 * Parsed node files, per directory, shared by every FileMemoryStore instance (callers construct a
 * fresh store for each use). Parsing the frontmatter YAML of every node file is what made listing
 * slow: about 2.5 s of the 2.7 s it took for 7.9k nodes, against 180 ms to read the files. An entry is
 * reused while the file's mtime and size are unchanged. A rewrite that keeps both identical (same
 * length, inside one filesystem timestamp tick) would be missed; node writes change the size in
 * practice (an added edge, a new subject), and a stat before the read means a write landing mid-read
 * still shows up as a changed mtime on the next listing.
 */
const nodeFileCaches = new Map<string, Map<string, CachedNodeFile>>();

/**
 * The in-memory cache above starts empty in every process, so the first listing after each restart
 * still parsed all 7.9k files (about 3 s, blocking the event loop). The default memory directory's
 * cache is therefore also written to a file next to it and loaded on first use. Entries carry the
 * same mtime and size check, so a stale or foreign file only costs a re-parse of what changed; the
 * services sharing a directory each write it atomically (temp file, then rename).
 */

/** Bump when `parseNode`'s output changes, so a cache written by an older build is not trusted. */
const PERSISTED_NODE_CACHE_VERSION = 1;
/** Writes are coalesced: consolidation adds nodes every chunk and each listing after that would rewrite it. */
const PERSIST_DELAY_MS = 3000;

const persistingDirs = new Set<string>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistedCachePath(dir: string): string {
	return join(dirname(dir), `.${basename(dir)}.node-cache.json`);
}

function isCachedNodeFile(value: unknown): value is CachedNodeFile {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<CachedNodeFile>;
	if (typeof entry.mtimeMs !== "number" || typeof entry.size !== "number") return false;
	if (entry.node === null) return true;
	const node = entry.node as Partial<MemoryNode> | undefined;
	return (
		typeof node === "object" &&
		node !== null &&
		typeof node.id === "string" &&
		typeof node.subject === "string" &&
		typeof node.at === "string" &&
		Array.isArray(node.edges)
	);
}

function loadPersistedNodeCache(dir: string): Map<string, CachedNodeFile> {
	const cache = new Map<string, CachedNodeFile>();
	try {
		const parsed = JSON.parse(readFileSync(persistedCachePath(dir), "utf8")) as {
			version?: number;
			entries?: Record<string, unknown>;
		};
		if (parsed.version !== PERSISTED_NODE_CACHE_VERSION || typeof parsed.entries !== "object" || !parsed.entries) {
			return cache;
		}
		for (const [name, entry] of Object.entries(parsed.entries)) if (isCachedNodeFile(entry)) cache.set(name, entry);
	} catch {
		// Missing, unreadable or corrupt: start empty and rebuild. The cache is only an optimization.
	}
	return cache;
}

/** Writes the directory's cache now (used by the debounce timer, and by tests and shutdown hooks). */
export async function flushPersistedNodeCache(dir: string): Promise<void> {
	const timer = persistTimers.get(dir);
	if (timer) {
		clearTimeout(timer);
		persistTimers.delete(dir);
	}
	const cache = nodeFileCaches.get(dir);
	if (!cache || !persistingDirs.has(dir)) return;
	const path = persistedCachePath(dir);
	const temp = `${path}.${process.pid}.tmp`;
	try {
		const contents = JSON.stringify({ version: PERSISTED_NODE_CACHE_VERSION, entries: Object.fromEntries(cache) });
		await writeFile(temp, contents, { mode: 0o600 });
		await rename(temp, path);
	} catch {
		// Best effort, same as loading.
	}
}

function schedulePersistedNodeCache(dir: string): void {
	if (persistTimers.has(dir)) return;
	const timer = setTimeout(() => {
		persistTimers.delete(dir);
		void flushPersistedNodeCache(dir);
	}, PERSIST_DELAY_MS);
	timer.unref?.();
	persistTimers.set(dir, timer);
}

/** Forgets every in-memory node cache, to simulate a fresh process (tests). Persisted files are untouched. */
export function clearMemoryNodeCaches(): void {
	nodeFileCaches.clear();
	persistingDirs.clear();
	for (const timer of persistTimers.values()) clearTimeout(timer);
	persistTimers.clear();
}

export interface FileMemoryStoreOptions {
	/**
	 * Persist the parsed-node cache next to the directory so a restarted process does not re-parse
	 * every file. Default: only for the default memory directory, so stores built on a throwaway
	 * directory (tests) leave nothing behind.
	 */
	persistIndex?: boolean;
}

export class FileMemoryStore implements MemoryStore {
	private readonly dir: string;
	private readonly persistIndex: boolean;

	constructor(dir?: string, options: FileMemoryStoreOptions = {}) {
		this.dir = dir ?? defaultMemoryDir();
		this.persistIndex = options.persistIndex ?? dir === undefined;
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

	/**
	 * All nodes currently on disk, malformed files silently skipped. Unchanged files come from a cache
	 * (see `nodeFileCaches`), so the returned nodes are shared between calls: treat them as read-only.
	 */
	listNodes(): MemoryNode[] {
		if (!existsSync(this.dir)) {
			nodeFileCaches.delete(this.dir);
			return [];
		}
		let cache = nodeFileCaches.get(this.dir);
		if (!cache) {
			cache = this.persistIndex ? loadPersistedNodeCache(this.dir) : new Map();
			nodeFileCaches.set(this.dir, cache);
		}
		if (this.persistIndex) persistingDirs.add(this.dir);
		const seen = new Set<string>();
		const nodes: MemoryNode[] = [];
		let changed = false;
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".md")) continue;
			const path = join(this.dir, name);
			try {
				// Stat before reading: a write that lands mid-read then changes the mtime we compare next time.
				const stat = statSync(path);
				let entry = cache.get(name);
				if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
					entry = { mtimeMs: stat.mtimeMs, size: stat.size, node: parseNode(readFileSync(path, "utf8")) ?? null };
					cache.set(name, entry);
					changed = true;
				}
				seen.add(name);
				if (entry.node) nodes.push(entry.node);
			} catch (error) {
				// A file removed between listing the directory and reading it is simply gone.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		for (const name of cache.keys()) {
			if (seen.has(name)) continue;
			cache.delete(name);
			changed = true;
		}
		if (changed && this.persistIndex) schedulePersistedNodeCache(this.dir);
		return nodes;
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
		// Same score as `matcher.score` over the node's text, without one regex test per query term per node:
		// a term (letters and digits only) matches `\bterm\b` exactly when it equals a whole word-character
		// run, and a term repeated in the query counts once per repetition, as it does there.
		const termWeight = new Map<string, number>();
		for (const term of matcher.terms) termWeight.set(term, (termWeight.get(term) ?? 0) + 1);
		const scoreOf = (n: MemoryNode): number => {
			let score = 0;
			for (const token of tokensOf(n)) score += termWeight.get(token) ?? 0;
			return score;
		};

		const scores = new Map(nodes.map((n) => [n.id, scoreOf(n)]));
		const entryIds = nodes.filter((n) => (scores.get(n.id) ?? 0) > 0).map((n) => n.id);
		if (entryIds.length === 0) return [];

		// Who points at each node, in listing order. Walking edges backwards used to scan every node for
		// every visited node, which took seconds on 7.9k nodes; this index is built once in O(edges).
		const incoming = new Map<string, string[]>();
		for (const n of nodes) {
			for (const edge of n.edges) {
				const sources = incoming.get(edge.target);
				if (!sources) incoming.set(edge.target, [n.id]);
				else if (sources[sources.length - 1] !== n.id) sources.push(n.id);
			}
		}

		const depth = new Map<string, number>();
		const queue: Array<{ id: string; d: number }> = entryIds.map((id) => ({ id, d: 0 }));
		for (let head = 0; head < queue.length; head++) {
			const { id, d } = queue[head];
			if (depth.has(id)) continue;
			depth.set(id, d);
			if (d >= 2) continue;
			const node = byId.get(id);
			if (!node) continue;
			for (const edge of node.edges) if (!depth.has(edge.target)) queue.push({ id: edge.target, d: d + 1 });
			for (const sourceId of incoming.get(id) ?? [])
				if (!depth.has(sourceId)) queue.push({ id: sourceId, d: d + 1 });
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
