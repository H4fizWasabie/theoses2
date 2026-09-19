import { join } from "node:path";
import { FileMemoryStore, getMemoriesDir } from "theoses-coding-agent";

export interface MemoryGraphNode {
	id: string;
	subject: string;
	at: string;
	path: string;
}

export interface MemoryGraphEdge {
	source: string;
	target: string;
	rel: string;
}

export interface MemoryGraph {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
}

/** How long a built graph is reused. Building it reads and parses every memory file synchronously. */
export const MEMORY_GRAPH_CACHE_TTL_MS = 60_000;

export interface MemoryGraphReaderOptions {
	load?: () => MemoryGraph;
	ttlMs?: number;
	now?: () => number;
}

/**
 * Wraps a graph loader in a short-lived cache. `listNodes` reads and YAML-parses every memory file
 * synchronously (about 2.6 s for 7.9k nodes), which blocks the whole dashboard process, so repeated
 * opens of the graph view reuse the last result. `fresh` (the view's refresh button) bypasses it.
 */
export function createMemoryGraphReader(options: MemoryGraphReaderOptions = {}) {
	const load = options.load ?? buildMemoryGraph;
	const ttlMs = options.ttlMs ?? MEMORY_GRAPH_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	let cached: { builtAt: number; graph: MemoryGraph } | undefined;
	return async function readMemoryGraph(read: { fresh?: boolean } = {}): Promise<MemoryGraph> {
		if (!read.fresh && cached && now() - cached.builtAt < ttlMs) return cached.graph;
		const graph = load();
		cached = { builtAt: now(), graph };
		return graph;
	};
}

export const readMemoryGraph = createMemoryGraphReader();

function buildMemoryGraph(): MemoryGraph {
	const store = new FileMemoryStore();
	const nodes = store.listNodes();
	const dir = getMemoriesDir();
	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			subject: node.subject,
			at: node.at,
			path: join(dir, `${node.id}.md`),
		})),
		edges: nodes.flatMap((node) =>
			node.edges.map((edge) => ({ source: node.id, target: edge.target, rel: edge.rel })),
		),
	};
}
