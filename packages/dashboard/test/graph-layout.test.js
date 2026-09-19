import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildQuadtree,
	createGraph,
	GRAPH_ALPHA_MIN,
	GRAPH_REPULSION,
	isGraphSettled,
	reheatGraph,
	repulsionOn,
	stepGraphSimulation,
} from "../src/public/graph-layout.js";

/** Small deterministic PRNG so the tests do not depend on Math.random. */
function seededRandom(seed) {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function makeData(nodeCount, edgeCount, seed = 1) {
	const random = seededRandom(seed);
	const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, subject: `node ${i}` }));
	const edges = Array.from({ length: edgeCount }, () => ({
		source: `n${Math.floor(random() * nodeCount)}`,
		target: `n${Math.floor(random() * nodeCount)}`,
		rel: "related_to",
	}));
	return { nodes, edges };
}

function exactRepulsion(nodes, node) {
	let fx = 0;
	let fy = 0;
	for (const other of nodes) {
		if (other === node) continue;
		const dx = node.x - other.x;
		const dy = node.y - other.y;
		const distSq = Math.max(dx * dx + dy * dy, 25);
		const force = GRAPH_REPULSION / distSq;
		const dist = Math.sqrt(distSq);
		fx += (dx / dist) * force;
		fy += (dy / dist) * force;
	}
	return [fx, fy];
}

test("createGraph resolves edges to node references and drops dangling ones", () => {
	const graph = createGraph({
		nodes: [
			{ id: "a", subject: "A" },
			{ id: "b", subject: "B" },
			{ id: "c", subject: "C" },
		],
		edges: [
			{ source: "a", target: "b", rel: "depends_on" },
			{ source: "a", target: "missing", rel: "depends_on" },
			{ source: "ghost", target: "c", rel: "supersedes" },
		],
	});

	assert.equal(graph.links.length, 1);
	assert.equal(graph.links[0].source, graph.nodes[0]);
	assert.equal(graph.links[0].target, graph.nodes[1]);
	assert.equal(graph.alpha, 1);
});

test("createGraph groups every node under exactly one cluster color", () => {
	const graph = createGraph(makeData(300, 200));

	const grouped = [...graph.colorGroups.values()].reduce((sum, group) => sum + group.length, 0);
	assert.equal(grouped, 300);
	for (const [color, group] of graph.colorGroups) {
		for (const node of group) assert.equal(node.clusterColor, color);
	}
});

test("Barnes-Hut repulsion stays close to the exact all-pairs force", () => {
	const graph = createGraph(makeData(800, 400, 7));
	const nodes = graph.nodes;
	// Spread the nodes out so the tree has real structure, not just the initial cluster seeding.
	for (let i = 0; i < 40; i++) stepGraphSimulation(graph);
	const tree = buildQuadtree(nodes);

	let sumError = 0;
	let sumMagnitude = 0;
	for (let i = 0; i < nodes.length; i += 8) {
		const [ex, ey] = exactRepulsion(nodes, nodes[i]);
		const [ax, ay] = repulsionOn(tree, nodes[i]);
		assert.ok(Number.isFinite(ax) && Number.isFinite(ay));
		sumError += Math.hypot(ax - ex, ay - ey);
		sumMagnitude += Math.hypot(ex, ey);
	}
	assert.ok(
		sumError / sumMagnitude < 0.1,
		`mean relative force error ${(sumError / sumMagnitude).toFixed(3)} should be under 0.1`,
	);
});

test("nodes at identical coordinates do not recurse forever", () => {
	const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, subject: "same", x: 5, y: 5, vx: 0, vy: 0 }));

	const tree = buildQuadtree(nodes);
	const [fx, fy] = repulsionOn(tree, nodes[0]);

	assert.ok(Number.isFinite(fx) && Number.isFinite(fy));
});

test("an empty graph steps without error", () => {
	const graph = createGraph({ nodes: [], edges: [] });

	stepGraphSimulation(graph);

	assert.equal(graph.nodes.length, 0);
});

test("the simulation cools, settles and stays finite", () => {
	const graph = createGraph(makeData(400, 300, 3));
	assert.equal(isGraphSettled(graph), false);

	let steps = 0;
	while (!isGraphSettled(graph) && steps < 1000) {
		stepGraphSimulation(graph);
		steps++;
	}

	assert.ok(isGraphSettled(graph));
	assert.ok(graph.alpha < GRAPH_ALPHA_MIN);
	// ln(0.01) / ln(0.985) is about 305 steps; allow a little slack either way.
	assert.ok(steps > 250 && steps < 400, `settled after ${steps} steps`);
	for (const node of graph.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
});

test("reheating wakes a settled graph and never cools it below where it was", () => {
	const graph = createGraph(makeData(50, 30));
	graph.alpha = 0.001;
	assert.ok(isGraphSettled(graph));

	reheatGraph(graph, 0.3);
	assert.equal(graph.alpha, 0.3);
	assert.equal(isGraphSettled(graph), false);

	reheatGraph(graph, 0.1);
	assert.equal(graph.alpha, 0.3);
});

test("pinned nodes do not move while the rest of the graph does", () => {
	const graph = createGraph(makeData(120, 80, 5));
	const nodes = graph.nodes;
	const pinned = nodes[0];
	pinned.pinned = true;
	const before = { x: pinned.x, y: pinned.y };
	const other = nodes[1];
	const otherBefore = { x: other.x, y: other.y };

	for (let i = 0; i < 20; i++) stepGraphSimulation(graph);

	assert.deepEqual({ x: pinned.x, y: pinned.y }, before);
	assert.notDeepEqual({ x: other.x, y: other.y }, otherBefore);
});

test("one step on an 8k-node graph costs a small fraction of the old all-pairs step", () => {
	// The old step compared every node with every other and searched by id per edge: about 350-500 ms on this size.
	const graph = createGraph(makeData(8000, 5200, 11));
	stepGraphSimulation(graph); // warm up the JIT

	const started = performance.now();
	stepGraphSimulation(graph);
	const elapsed = performance.now() - started;

	assert.ok(elapsed < 300, `one step took ${elapsed.toFixed(0)} ms`);
});
