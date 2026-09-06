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

export async function readMemoryGraph(): Promise<MemoryGraph> {
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
