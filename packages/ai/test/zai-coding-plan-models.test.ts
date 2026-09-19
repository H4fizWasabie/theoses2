import { expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", () => {
	const model = getBuiltinModel("zai-coding-cn", "glm-4.6v");

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	// glm-5.1 and glm-5v-turbo were retired from the China Coding Plan catalog in favor of
	// glm-5.3/glm-5.3-flash - both now carry their own directly-published API price rather than
	// borrowing a reference cost from the "zai" pay-as-you-go catalog.
	expect(getBuiltinModel("zai-coding-cn", "glm-5.3").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	// models.dev doubled glm-5.3-flash from 0.075/0.25 to 0.15/0.5 on 2026-09-19; the build
	// regenerates costs from it, so this tracks the current published price.
	expect(getBuiltinModel("zai-coding-cn", "glm-5.3-flash").cost).toEqual({
		input: 0.15,
		output: 0.5,
		cacheRead: 0.03,
		cacheWrite: 0,
	});
});

it("keeps zero costs for Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	// glm-5.2-highspeed only exists on "zai" now - dropped from zai-coding-cn (see above).
	expect(getBuiltinModel("zai", "glm-5.2-highspeed").cost).toEqual(zeroCost);
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3-highspeed").cost).toEqual(zeroCost);
	}
});
