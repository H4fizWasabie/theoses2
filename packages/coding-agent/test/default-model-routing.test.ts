import { describe, expect, it, vi } from "vitest";
import { type BackgroundModelName, resolveBackgroundModel } from "../src/core/background-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash-0731";
const MAX_TOKENS: Record<BackgroundModelName, number> = { consolidation: 32000, explorer: 8000, research: 16000 };
const NAMES = Object.keys(MAX_TOKENS) as BackgroundModelName[];

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

describe("default DeepSeek V4 Flash 0731 routing", () => {
	it.each(NAMES)("%s asks for the paid variant and pins Baidu then DeepInfra with no other fallbacks", (name) => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveBackgroundModel(runtime, name);

		expect(getModel).toHaveBeenCalledWith("openrouter", DEFAULT_MODEL_ID);
		expect(routingOf(model)).toMatchObject({
			order: ["Baidu", "DeepInfra"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
		expect(model.maxTokens).toBe(MAX_TOKENS[name]);
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
