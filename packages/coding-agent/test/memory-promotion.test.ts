import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPromotion } from "../src/core/memory-promotion.ts";
import type { MemoryStore } from "../src/core/memory-store.ts";

const message = (text: string) => ({ role: "user", content: text }) as unknown as AgentMessage;

function setup(options: { promoted?: string[]; branch?: unknown[] } = {}) {
	const saved: string[] = [];
	const store = {
		saveNote: vi.fn((text: string) => {
			saved.push(text);
			return { text };
		}),
	} as unknown as MemoryStore;
	const branch = options.branch ?? [];
	const log = {
		isEntryPromoted: (id: string) => options.promoted?.includes(id) ?? false,
		appendPromotedRange: vi.fn(() => "p1"),
		getBranch: () => branch as never,
	};
	return { saved, log, promotion: createMemoryPromotion(store, log) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("distillDropped", () => {
	it("distills only messages no earlier save covered", async () => {
		const { promotion, saved } = setup({ promoted: ["e1"] });
		const distill = vi.fn(async () => ({ facts: [{ fact: "likes tea", confidence: 1 }], episode: "chatted" }));

		promotion.distillDropped([message("a"), message("b"), message("c")], ["e0", "e1", "e2"], distill);
		await flush();

		expect(distill).toHaveBeenCalledWith([message("a"), message("c")]);
		expect(saved).toEqual(["likes tea", "Episode: chatted"]);
	});

	it("makes no LLM call when everything is already promoted", () => {
		const { promotion } = setup({ promoted: ["e0"] });
		const distill = vi.fn();

		promotion.distillDropped([message("a")], ["e0"], distill);

		expect(distill).not.toHaveBeenCalled();
	});

	it("distills everything when compaction gives no entry ids", async () => {
		const { promotion } = setup();
		const distill = vi.fn(async () => ({ facts: [] }));

		promotion.distillDropped([message("a")], undefined, distill);
		await flush();

		expect(distill).toHaveBeenCalledWith([message("a")]);
	});

	it("swallows a failed pass instead of failing compaction", async () => {
		const { promotion, saved } = setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		promotion.distillDropped([message("a")], undefined, async () => {
			throw new Error("boom");
		});
		await flush();

		expect(saved).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("recordSaved", () => {
	const user = (id: string) => ({ id, type: "message", message: { role: "user" } });
	const other = (id: string) => ({ id, type: "message", message: { role: "assistant" } });

	it("marks the current turn: the last user message up to the save", () => {
		const { promotion, log } = setup({
			branch: [other("e0"), user("e1"), other("e2"), user("e3"), other("e4"), other("e5")],
		});

		promotion.recordSaved();

		expect(log.appendPromotedRange).toHaveBeenCalledWith("e3", "e5");
	});

	it("covers a tool-heavy turn longer than 20 entries back to its user message", () => {
		const branch = [user("u"), ...Array.from({ length: 30 }, (_, i) => other(`t${i}`))];
		const { promotion, log } = setup({ branch });

		promotion.recordSaved();

		expect(log.appendPromotedRange).toHaveBeenCalledWith("u", "t29");
	});

	it("does nothing when the branch has no user message", () => {
		const { promotion, log } = setup({ branch: [other("e0")] });

		promotion.recordSaved();

		expect(log.appendPromotedRange).not.toHaveBeenCalled();
	});
});
