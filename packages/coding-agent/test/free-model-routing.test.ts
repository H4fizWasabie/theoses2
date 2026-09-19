import { describe, expect, it, vi } from "vitest";
import { resolveExplorerModel } from "../src/core/explorer.ts";
import { resolveConsolidationModel } from "../src/core/memory-consolidation.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

const FREE_MODEL_ID = "deepseek/deepseek-v4-flash-0731:free";

function runtimeWithModel(): { runtime: ModelRuntime; getModel: ReturnType<typeof vi.fn> } {
	const getModel = vi.fn(() => ({
		id: FREE_MODEL_ID,
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

describe("free DeepSeek V4 Flash 0731 routing", () => {
	it("consolidation asks for the free variant and pins OpenInference with no fallbacks", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveConsolidationModel(runtime);

		expect(getModel).toHaveBeenCalledWith("openrouter", FREE_MODEL_ID);
		expect(routingOf(model)).toMatchObject({
			order: ["OpenInference"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
		expect(model.maxTokens).toBe(32000);
	});

	it("the explorer asks for the free variant and pins OpenInference with no fallbacks", () => {
		const { runtime, getModel } = runtimeWithModel();

		const model = resolveExplorerModel(runtime);

		expect(getModel).toHaveBeenCalledWith("openrouter", FREE_MODEL_ID);
		expect(routingOf(model)).toMatchObject({
			order: ["OpenInference"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
		expect(model.maxTokens).toBe(8000);
	});

	it("fails loudly when the catalog does not contain the free variant", () => {
		const runtime = { getModel: () => undefined } as unknown as ModelRuntime;

		expect(() => resolveConsolidationModel(runtime)).toThrow(/not found in the OpenRouter catalog/);
		expect(() => resolveExplorerModel(runtime)).toThrow(/not found in the OpenRouter catalog/);
	});
});
