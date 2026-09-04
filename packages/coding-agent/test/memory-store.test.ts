import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMemoryStore } from "../src/core/memory-store.ts";

describe("FileMemoryStore (semantic graph)", () => {
	let dir: string;
	let store: FileMemoryStore;

	beforeEach(() => {
		dir = join(tmpdir(), `theoses-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		store = new FileMemoryStore(dir);
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("saveNote writes a bare node with no edges", () => {
		const record = store.saveNote("User prefers Go for backend work");
		expect(record.text).toBe("User prefers Go for backend work");
		const node = store.getNode(record.id);
		expect(node?.edges).toEqual([]);
	});

	it("createNode supports edges and a body", () => {
		const other = store.createNode({ subject: "Other fact" });
		const node = store.createNode({
			subject: "Depends on other fact",
			edges: [{ target: other.id, rel: "depends_on" }],
			body: "Extra detail.",
		});
		expect(node.edges).toEqual([{ target: other.id, rel: "depends_on" }]);
		expect(node.body).toBe("Extra detail.");
	});

	it("addEdge appends without duplicating an identical edge", () => {
		const a = store.createNode({ subject: "A" });
		const b = store.createNode({ subject: "B" });
		store.addEdge(a.id, { target: b.id, rel: "used_in" });
		store.addEdge(a.id, { target: b.id, rel: "used_in" });
		expect(store.getNode(a.id)?.edges).toHaveLength(1);
	});

	it("remember matches on keyword and traverses edges up to 2 hops", () => {
		const project = store.createNode({ subject: "Project Theoses is a personal assistant" });
		const convention = store.createNode({
			subject: "Theoses uses channel-keyed sessions",
			edges: [{ target: project.id, rel: "used_in" }],
		});
		const unrelated = store.createNode({ subject: "Completely unrelated fact" });

		const results = store.remember("theoses");
		const ids = results.map((r) => r.id);
		expect(ids).toContain(project.id);
		expect(ids).toContain(convention.id);
		expect(ids).not.toContain(unrelated.id);
	});

	it("remember hides nodes superseded by a newer node", () => {
		const old = store.createNode({ subject: "VPS IP is 1.2.3.4" });
		store.createNode({
			subject: "VPS IP is 5.6.7.8",
			edges: [{ target: old.id, rel: "supersedes" }],
		});

		const results = store.remember("VPS IP");
		expect(results.map((r) => r.text)).not.toContain("VPS IP is 1.2.3.4");
		expect(results.map((r) => r.text)).toContain("VPS IP is 5.6.7.8");
	});

	it("remember returns nothing for an empty store", () => {
		expect(store.remember("anything")).toEqual([]);
	});
});

describe("FileMemoryStore legacy migration", () => {
	let dir: string;
	let legacyFile: string;

	beforeEach(() => {
		const root = join(tmpdir(), `theoses-memory-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		dir = join(root, "memories");
		legacyFile = join(root, "memory.jsonl");
		process.env.THEOSES_MEMORY_FILE = legacyFile;
	});

	afterEach(() => {
		delete process.env.THEOSES_MEMORY_FILE;
		const root = join(dir, "..");
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("imports each legacy line as a bare node on first construction, preserving id and timestamp", () => {
		writeFileSync(
			legacyFile,
			`${JSON.stringify({ id: "abc-123", createdAt: "2026-09-03T10:03:16.955Z", text: 'User\'s name is Hafiz. Always refer to him as "abah".' })}\n`,
		);
		const store = new FileMemoryStore(dir);
		const node = store.getNode("abc-123");
		expect(node?.subject).toBe('User\'s name is Hafiz. Always refer to him as "abah".');
		expect(node?.at).toBe("2026-09-03T10:03:16.955Z");
	});

	it("does not re-run migration once the directory already exists", () => {
		writeFileSync(legacyFile, `${JSON.stringify({ id: "a", createdAt: "2026-01-01T00:00:00.000Z", text: "A" })}\n`);
		new FileMemoryStore(dir);
		const store = new FileMemoryStore(dir);
		store.getNode("a");
		expect(store.listNodes()).toHaveLength(1);
	});
});
