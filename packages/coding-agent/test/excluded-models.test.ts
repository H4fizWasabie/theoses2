import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createModelExcluder } from "../src/core/excluded-models.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const deepseek = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
const glm = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

describe("createModelExcluder", () => {
	it("excludes nothing without patterns", () => {
		expect(createModelExcluder([])(deepseek)).toBe(false);
	});

	it("matches the bare id, the provider/id form, and any part of the name with *", () => {
		expect(createModelExcluder(["deepseek/*"])(deepseek)).toBe(true);
		expect(createModelExcluder(["openrouter/deepseek/deepseek-v4.1-flash"])(deepseek)).toBe(true);
		expect(createModelExcluder(["*deepseek*"])(deepseek)).toBe(true);
		expect(createModelExcluder(["*deepseek*"])(glm)).toBe(false);
	});

	it("ignores case and treats regex characters literally", () => {
		expect(createModelExcluder(["*DeepSeek*"])(deepseek)).toBe(true);
		expect(createModelExcluder(["z-ai/glm-5.3-flash"])({ provider: "openrouter", id: "z-ai/glm-5x3-flash" })).toBe(
			false,
		);
		expect(createModelExcluder(["a+b(c"])(glm)).toBe(false);
	});

	it("matches a whole pattern, not a substring, unless it uses *", () => {
		expect(createModelExcluder(["deepseek"])(deepseek)).toBe(false);
	});

	describe("! allow patterns", () => {
		it("lift a model that an exclude pattern matches", () => {
			const isExcluded = createModelExcluder(["*deepseek*", "!openrouter/deepseek/deepseek-v4.1-flash"]);
			expect(isExcluded(deepseek)).toBe(false);
		});

		it("win regardless of order", () => {
			const isExcluded = createModelExcluder(["!openrouter/deepseek/deepseek-v4.1-flash", "*deepseek*"]);
			expect(isExcluded(deepseek)).toBe(false);
		});

		it("exclude nothing on their own", () => {
			expect(createModelExcluder(["!*deepseek*"])(deepseek)).toBe(false);
			expect(createModelExcluder(["!*deepseek*"])(glm)).toBe(false);
		});

		it("match like exclude patterns: provider/id or bare id, ignoring case, * wildcard", () => {
			expect(createModelExcluder(["*", "!DeepSeek/*"])(deepseek)).toBe(false);
			expect(createModelExcluder(["*", "!OpenRouter/deepseek/*"])(deepseek)).toBe(false);
			expect(createModelExcluder(["*", "!deepseek"])(deepseek)).toBe(true);
		});

		it("keep a bare-id allow pattern open on every provider that uses that id", () => {
			const isExcluded = createModelExcluder(["*deepseek*", "!deepseek/deepseek-v4.1-flash"]);
			expect(isExcluded({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" })).toBe(false);
			expect(isExcluded({ provider: "other", id: "deepseek/deepseek-v4.1-flash" })).toBe(false);
		});

		it("turn the production DeepSeek enumeration into one exclude and one allow", () => {
			const isExcluded = createModelExcluder(["*deepseek*", "!openrouter/deepseek/deepseek-v4.1-flash"]);
			expect(isExcluded({ provider: "openrouter", id: "deepseek/deepseek-v4.2-flash" })).toBe(true);
			expect(isExcluded({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash:batch" })).toBe(true);
			expect(isExcluded({ provider: "together", id: "deepseek-ai/DeepSeek-V4.1-Flash" })).toBe(true);
			expect(isExcluded({ provider: "deepseek", id: "deepseek-v4-flash" })).toBe(true);
			expect(isExcluded(deepseek)).toBe(false);
			expect(isExcluded(glm)).toBe(false);
		});
	});
});

describe("ModelRuntime.setExcludedModels", () => {
	async function runtime() {
		const auth = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "test-key" } });
		return getModelRuntime(await createModelRegistry(auth));
	}
	const hasDeepseek = (models: readonly { id: string }[]) =>
		models.some((m) => m.id.toLowerCase().includes("deepseek"));

	it("hides matching models from every way of listing or looking one up", async () => {
		const r = await runtime();
		expect(r.getModel("openrouter", deepseek.id)).toBeDefined();
		expect(hasDeepseek(r.getModels())).toBe(true);

		r.setExcludedModels(["*deepseek*"]);

		expect(r.getModel("openrouter", deepseek.id)).toBeUndefined();
		expect(hasDeepseek(r.getModels())).toBe(false);
		expect(hasDeepseek(r.getModels("openrouter"))).toBe(false);
		expect(hasDeepseek(r.getAvailableSnapshot())).toBe(false);
		expect(hasDeepseek(await r.getAvailable())).toBe(false);
		expect(r.getModel("openrouter", glm.id)).toBeDefined();
	});

	it("keeps a model that a ! allow pattern names and hides the rest of the family", async () => {
		const r = await runtime();
		r.setExcludedModels(["*deepseek*", "!openrouter/deepseek/deepseek-v4.1-flash"]);
		expect(r.getModel("openrouter", deepseek.id)).toBeDefined();
		expect(
			r
				.getModels()
				.filter((m) => m.id.toLowerCase().includes("deepseek"))
				.map((m) => m.id),
		).toEqual([deepseek.id]);
	});

	it("brings a model back when the pattern is removed", async () => {
		const r = await runtime();
		r.setExcludedModels(["*deepseek*"]);
		r.setExcludedModels([]);
		expect(r.getModel("openrouter", deepseek.id)).toBeDefined();
	});
});
