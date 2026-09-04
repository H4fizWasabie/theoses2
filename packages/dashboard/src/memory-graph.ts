import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, FileMemoryStore } from "theoses-coding-agent";

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

/** Mirrors FileMemoryStore's own default (and THEOSES_MEMORY_DIR override) so paths line up with the file workbench. */
function memoryDir(): string {
	return process.env.THEOSES_MEMORY_DIR ?? join(homedir(), CONFIG_DIR_NAME, "memories");
}

export async function readMemoryGraph(): Promise<MemoryGraph> {
	const store = new FileMemoryStore();
	const nodes = store.listNodes();
	const dir = memoryDir();
	return {
		nodes: nodes.map((node) => ({ id: node.id, subject: node.subject, at: node.at, path: join(dir, `${node.id}.md`) })),
		edges: nodes.flatMap((node) => node.edges.map((edge) => ({ source: node.id, target: edge.target, rel: edge.rel }))),
	};
}
