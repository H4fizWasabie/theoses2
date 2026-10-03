import { getModel } from "theoses-ai/compat";
import { describe, expect, it } from "vitest";
import { resolveThinkingLevel } from "../src/core/thinking-level.ts";

const reasoning = getModel("anthropic", "claude-sonnet-4-5")!;
const plain = { ...reasoning, reasoning: false };

describe("resolveThinkingLevel", () => {
	it.each([
		["nothing set: the default", {}, "medium"],
		["current beats the default", { current: "low" }, "low"],
		["global default beats current", { globalDefault: "high", current: "low" }, "high"],
		["per-model beats global default", { perModel: "low", globalDefault: "high" }, "low"],
		["saved beats per-model", { saved: "minimal", perModel: "low" }, "minimal"],
		[
			"explicit beats everything",
			{ explicit: "high", saved: "minimal", perModel: "low", globalDefault: "off" },
			"high",
		],
	] as const)("%s", (_name, sources, expected) => {
		expect(resolveThinkingLevel({ model: reasoning, ...sources })).toBe(expected);
	});

	it("clamps to what the model supports", () => {
		expect(resolveThinkingLevel({ model: plain, explicit: "high" })).toBe("off");
	});

	it("is off without a model", () => {
		expect(resolveThinkingLevel({ model: undefined, explicit: "high" })).toBe("off");
	});
});
