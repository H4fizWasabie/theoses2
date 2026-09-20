import { describe, expect, it, vi } from "vitest";
import { resolveExplorerModel } from "../src/core/explorer.ts";
import { resolveConsolidationModel } from "../src/core/memory-consolidation.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

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
	it("consolidation asks for the paid variant and pins Baidu then DeepInfra with no other fallbacks", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveConsolidationModel(runtime);

		expect(getModel).toHaveBeenCalledWith("openrouter", DEFAULT_MODEL_ID);
		expect(routingOf(model)).toMatchObject({
			order: ["Baidu", "DeepInfra"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
		expect(model.maxTokens).toBe(32000);
	});

	it("the explorer asks for the paid variant and pins Baidu then DeepInfra with no other fallbacks", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveExplorerModel(runtime);

		expect(getModel).toHaveBeenCalledWith("openrouter", DEFAULT_MODEL_ID);
		expect(routingOf(model)).toMatchObject({
			order: ["Baidu", "DeepInfra"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
		expect(model.maxTokens).toBe(8000);
	});

	it("does not default to a free variant, which OpenRouter can withdraw", () => {
		const { runtime, getModel } = runtimeWithModel();

		resolveConsolidationModel(runtime);
		resolveExplorerModel(runtime);

		for (const call of getModel.mock.calls) expect(String(call[1])).not.toMatch(/:free$/);
	});

	it("fails loudly when the catalog does not contain the model", () => {
		const runtime = { getModel: () => undefined } as unknown as ModelRuntime;

		expect(() => resolveConsolidationModel(runtime)).toThrow(/not found in the OpenRouter catalog/);
		expect(() => resolveExplorerModel(runtime)).toThrow(/not found in the OpenRouter catalog/);
	});
});
