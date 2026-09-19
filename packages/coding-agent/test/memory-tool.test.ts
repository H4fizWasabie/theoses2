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

function storeReturning(found: MemoryRecord[]): MemoryStore & { remember: ReturnType<typeof vi.fn> } {
	return { remember: vi.fn(() => found), saveNote: vi.fn() };
}

async function runRemember(tools: ReturnType<typeof createMemoryToolDefinitions>, query: string): Promise<string> {
	const remember = tools.find((tool) => tool.name === "remember");
	const result = await remember?.execute("call", { query }, undefined, undefined, {} as never);
	const first = result?.content[0];
	return first?.type === "text" ? first.text : "";
}

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
