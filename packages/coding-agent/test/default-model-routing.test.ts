import { describe, expect, it, vi } from "vitest";
import { type BackgroundModelName, resolveBackgroundModel } from "../src/core/background-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

const DEFAULT_MODEL_ID = "inclusionai/ling-3.0-flash-vl";
const MAX_TOKENS: Partial<Record<BackgroundModelName, number>> = {
	consolidation: 32000,
	explorer: 8000,
	research: 16000,
};
const NAMES = Object.keys(MAX_TOKENS) as BackgroundModelName[];
// The routing the production settings.json already runs each name on.
const ROUTING: Partial<Record<BackgroundModelName, { order: string[]; quantizations: string[] }>> = {
	consolidation: { order: ["DeepInfra"], quantizations: ["fp16"] },
	explorer: { order: ["Novita"], quantizations: ["bf16"] },
	research: { order: ["Novita"], quantizations: ["bf16"] },
};

function runtimeWithModel(): { runtime: ModelRuntime; getModel: ReturnType<typeof vi.fn> } {
	const getModel = vi.fn(() => ({
		id: DEFAULT_MODEL_ID,
		provider: "openrouter",
		api: "openai-completions",
		maxTokens: 393216,
		compat: {},
	}));
	return { runtime: { getModel } as unknown as ModelRuntime, getModel };
}

function routingOf(model: unknown): Record<string, unknown> {
	return (model as { compat: { openRouterRouting: Record<string, unknown> } }).compat.openRouterRouting;
}

describe("default Ling 3.0 Flash VL routing", () => {
	it.each(NAMES)("%s uses Ling 3.0 Flash VL on its own provider with no other fallbacks", (name) => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveBackgroundModel(runtime, name);

		expect(getModel).toHaveBeenCalledWith("openrouter", DEFAULT_MODEL_ID);
		expect(routingOf(model)).toMatchObject({ ...ROUTING[name], allow_fallbacks: false });
		expect(model.maxTokens).toBe(MAX_TOKENS[name]);
	});

	it("never defaults any background job to a DeepSeek model", () => {
		const { runtime, getModel } = runtimeWithModel();

		for (const name of [...NAMES, "reviewer" as const]) resolveBackgroundModel(runtime, name);

		for (const call of getModel.mock.calls) expect(String(call[1])).not.toMatch(/deepseek/i);
	});

	it("does not default to a free variant, which OpenRouter can withdraw", () => {
		const { runtime, getModel } = runtimeWithModel();

		for (const name of NAMES) resolveBackgroundModel(runtime, name);

		for (const call of getModel.mock.calls) expect(String(call[1])).not.toMatch(/:free$/);
	});

	it.each(NAMES)("%s fails loudly when the catalog does not contain the model", (name) => {
		const runtime = { getModel: () => undefined } as unknown as ModelRuntime;

		expect(() => resolveBackgroundModel(runtime, name)).toThrow(/not found in the OpenRouter catalog/);
	});
});

describe("reviewer routing", () => {
	it("defaults to GPT-6 Luna via OpenAI with no quantization filter and no fallbacks", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveBackgroundModel(runtime, "reviewer");

		expect(getModel).toHaveBeenCalledWith("openrouter", "openai/gpt-6-luna");
		expect(routingOf(model)).toEqual({ order: ["OpenAI"], allow_fallbacks: false });
		expect(model.maxTokens).toBe(8000);
	});
});

describe("background fallback routing", () => {
	it("defaults to GPT-6 Luna pinned to OpenAI's flex tier", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveBackgroundModel(runtime, "fallback");

		expect(getModel).toHaveBeenCalledWith("openrouter", "openai/gpt-6-luna");
		expect(routingOf(model)).toEqual({ order: ["openai/flex"], allow_fallbacks: false });
		expect(model.maxTokens).toBe(32000);
	});
});
