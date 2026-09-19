import { describe, expect, it, vi } from "vitest";
import { type MemoryRecord, type MemoryStore, REMEMBER_RESULT_LIMIT } from "../src/core/memory-store.ts";
import { createMemoryToolDefinitions } from "../src/core/tools/memory.ts";

function records(count: number): MemoryRecord[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `n${i}`,
		createdAt: "2026-09-19T00:00:00Z",
		text: `fact ${i}`,
	}));
}

function storeReturning(found: MemoryRecord[]) {
	return { remember: vi.fn<MemoryStore["remember"]>(() => found), saveNote: vi.fn<MemoryStore["saveNote"]>() };
}

async function runRemember(tools: ReturnType<typeof createMemoryToolDefinitions>, query: string): Promise<string> {
	const remember = tools.find((tool) => tool.name === "remember");
	const result = await remember?.execute("call", { query }, undefined, undefined, {} as never);
	const first = result?.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("save_note tool gate", () => {
	const existing = {
		id: "old",
		type: "semantic" as const,
		subject: "Hafiz is the creator of Theoses",
		at: "2026-09-01T00:00:00.000Z",
		edges: [],
	};

	async function runSave(tools: ReturnType<typeof createMemoryToolDefinitions>, note: string): Promise<string> {
		const saveNote = tools.find((tool) => tool.name === "save_note");
		const result = await saveNote?.execute("call", { note }, undefined, undefined, {} as never);
		const first = result?.content[0];
		return first?.type === "text" ? first.text : "";
	}

	it("saves as before when there is no gate", async () => {
		const store = storeReturning([]);
		const text = await runSave(createMemoryToolDefinitions(store), "a fact");

		expect(store.saveNote).toHaveBeenCalledWith("a fact");
		expect(text).toBe("Durable note saved.");
	});

	it("does not write a fact that is already remembered, and says what is stored", async () => {
		const store = storeReturning([]);
		const onSaved = vi.fn();
		const gate = { check: vi.fn(async () => ({ action: "reuse" as const, existing })), supersede: vi.fn() };

		const text = await runSave(createMemoryToolDefinitions(store, onSaved, undefined, gate), "Hafiz created Theoses");

		expect(store.saveNote).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
		expect(text).toBe("Already remembered, so nothing was saved: Hafiz is the creator of Theoses");
	});

	it("writes a richer wording and marks the old node as replaced", async () => {
		const store = storeReturning([]);
		store.saveNote.mockReturnValue({ id: "new", createdAt: "2026-09-20T00:00:00Z", text: "richer" });
		const gate = { check: vi.fn(async () => ({ action: "supersede" as const, existing })), supersede: vi.fn() };

		const text = await runSave(createMemoryToolDefinitions(store, undefined, undefined, gate), "richer");

		expect(gate.supersede).toHaveBeenCalledWith("new", "old");
		expect(text).toBe("Durable note saved. It replaces a less detailed note: Hafiz is the creator of Theoses");
	});

	it("saves a new fact normally", async () => {
		const store = storeReturning([]);
		const gate = { check: vi.fn(async () => ({ action: "store" as const })), supersede: vi.fn() };

		expect(await runSave(createMemoryToolDefinitions(store, undefined, undefined, gate), "brand new")).toBe(
			"Durable note saved.",
		);
		expect(store.saveNote).toHaveBeenCalledWith("brand new");
		expect(gate.supersede).not.toHaveBeenCalled();
	});
});

describe("remember tool", () => {
	it("behaves as before when no relevance stage is configured", async () => {
		const store = storeReturning(records(3));
		const text = await runRemember(createMemoryToolDefinitions(store), "anything");

		expect(store.remember).toHaveBeenCalledWith("anything", undefined);
		expect(text).toBe("- fact 0\n- fact 1\n- fact 2");
	});

	it("says so when nothing matches", async () => {
		const rank = vi.fn();
		const text = await runRemember(
			createMemoryToolDefinitions(storeReturning([]), undefined, { candidates: 20, rank }),
			"anything",
		);

		expect(text).toBe("No matching memory.");
		expect(rank).not.toHaveBeenCalled();
	});

	it("asks the store for the wider pool and shows the ranked records", async () => {
		const store = storeReturning(records(5));
		const rank = vi.fn(async (_query: string, found: MemoryRecord[]) => [found[3], found[1]]);

		const text = await runRemember(
			createMemoryToolDefinitions(store, undefined, { candidates: 20, rank }),
			"the query",
		);

		expect(store.remember).toHaveBeenCalledWith("the query", 20);
		expect(rank).toHaveBeenCalledWith("the query", records(5));
		expect(text).toBe("- fact 3\n- fact 1");
	});

	it("falls back to the first plain keyword results when ranking returns nothing", async () => {
		const store = storeReturning(records(20));
		const rank = vi.fn(async () => undefined);

		const text = await runRemember(createMemoryToolDefinitions(store, undefined, { candidates: 20, rank }), "q");

		expect(text.split("\n")).toHaveLength(REMEMBER_RESULT_LIMIT);
		expect(text.startsWith("- fact 0\n- fact 1")).toBe(true);
	});
});
