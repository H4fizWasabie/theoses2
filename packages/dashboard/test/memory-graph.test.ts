import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryGraphReader, MEMORY_GRAPH_CACHE_TTL_MS, type MemoryGraph } from "../src/memory-graph.ts";

function graphWith(id: string): MemoryGraph {
	return { nodes: [{ id, subject: id, at: "2026-09-19T00:00:00.000Z", path: `/memories/${id}.md` }], edges: [] };
}

function harness() {
	let clock = 1_000_000;
	let loads = 0;
	const read = createMemoryGraphReader({
		load: () => graphWith(`load-${++loads}`),
		now: () => clock,
	});
	return {
		read,
		loads: () => loads,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test("the memory graph is built once and reused within the cache window", async () => {
	const { read, loads, advance } = harness();

	const first = await read();
	advance(MEMORY_GRAPH_CACHE_TTL_MS - 1);
	const second = await read();

	assert.equal(loads(), 1);
	assert.equal(second, first);
});

test("the memory graph is rebuilt once the cache window has passed", async () => {
	const { read, loads, advance } = harness();

	await read();
	advance(MEMORY_GRAPH_CACHE_TTL_MS);
	const rebuilt = await read();

	assert.equal(loads(), 2);
	assert.equal(rebuilt.nodes[0].id, "load-2");
});

test("fresh bypasses the cache and restarts the window", async () => {
	const { read, loads, advance } = harness();

	await read();
	const refreshed = await read({ fresh: true });
	advance(MEMORY_GRAPH_CACHE_TTL_MS - 1);
	const cached = await read();

	assert.equal(loads(), 2);
	assert.equal(cached, refreshed);
});
