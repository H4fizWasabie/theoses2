import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import {
	type BackgroundModelConfig,
	type ResolvedBackgroundModelSetting,
	resolveBackgroundModelSetting,
} from "../src/core/background-models.ts";
import { resolveExplorerModel } from "../src/core/explorer.ts";
import { resolveConsolidationModel } from "../src/core/memory-consolidation.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const DEFAULTS: ResolvedBackgroundModelSetting = {
	model: "vendor/default-model:free",
	providers: ["DefaultProvider"],
	quantizations: ["fp8"],
};

describe("resolveBackgroundModelSetting", () => {
	it("returns the defaults when there is no override", () => {
		expect(resolveBackgroundModelSetting("consolidation", DEFAULTS, undefined)).toBe(DEFAULTS);
		expect(resolveBackgroundModelSetting("consolidation", DEFAULTS, null)).toBe(DEFAULTS);
	});

	it("overrides only the fields that are set", () => {
		expect(resolveBackgroundModelSetting("explorer", DEFAULTS, { model: "vendor/other" })).toEqual({
			model: "vendor/other",
			providers: ["DefaultProvider"],
			quantizations: ["fp8"],
		});
		expect(resolveBackgroundModelSetting("explorer", DEFAULTS, { providers: ["A", "B"], quantizations: [] })).toEqual(
			{
				model: "vendor/default-model:free",
				providers: ["A", "B"],
				quantizations: [],
			},
		);
	});

	it("rejects malformed values with the setting's path in the message", () => {
		expect(() => resolveBackgroundModelSetting("consolidation", DEFAULTS, "oops")).toThrow(
			/backgroundModels\.consolidation must be an object/,
		);
		expect(() => resolveBackgroundModelSetting("consolidation", DEFAULTS, { model: "" })).toThrow(
			/backgroundModels\.consolidation\.model/,
		);
		expect(() => resolveBackgroundModelSetting("explorer", DEFAULTS, { providers: [] })).toThrow(
			/backgroundModels\.explorer\.providers must be a non-empty list/,
		);
		expect(() => resolveBackgroundModelSetting("explorer", DEFAULTS, { providers: ["A", 3] })).toThrow(
			/backgroundModels\.explorer\.providers/,
		);
		expect(() => resolveBackgroundModelSetting("explorer", DEFAULTS, { quantizations: "fp8" })).toThrow(
			/backgroundModels\.explorer\.quantizations/,
		);
	});
});

function runtimeWith(config: BackgroundModelConfig): { runtime: ModelRuntime; getModel: ReturnType<typeof vi.fn> } {
	const getModel = vi.fn((_provider: string, id: string) => ({
		id,
		provider: "openrouter",
		api: "openai-completions",
		maxTokens: 393216,
		compat: {},
	}));
	const runtime = {
		getModel,
		getBackgroundModelSetting: (name: keyof BackgroundModelConfig) => config[name],
	} as unknown as ModelRuntime;
	return { runtime, getModel };
}

function routingOf(model: unknown): Record<string, unknown> {
	return (model as { compat: { openRouterRouting: Record<string, unknown> } }).compat.openRouterRouting;
}

describe("background model resolvers honour backgroundModels overrides", () => {
	it("consolidation uses the configured model, providers and quantizations", () => {
		const { runtime, getModel } = runtimeWith({
			consolidation: {
				model: "deepseek/deepseek-v4-flash-0731",
				providers: ["Baidu", "DeepInfra"],
				quantizations: ["fp8"],
			},
		});

		const model = resolveConsolidationModel(runtime);

		expect(getModel).toHaveBeenCalledWith("openrouter", "deepseek/deepseek-v4-flash-0731");
		expect(routingOf(model)).toMatchObject({
			order: ["Baidu", "DeepInfra"],
			quantizations: ["fp8"],
			allow_fallbacks: false,
		});
	});

	it("an empty quantizations list leaves the filter out of the routing", () => {
		const { runtime } = runtimeWith({ explorer: { quantizations: [] } });

		const model = resolveExplorerModel(runtime);

		expect(routingOf(model)).not.toHaveProperty("quantizations");
		expect(routingOf(model)).toMatchObject({ order: ["Baidu", "DeepInfra"], allow_fallbacks: false });
	});

	it("the explorer and consolidation are configured independently", () => {
		const { runtime, getModel } = runtimeWith({ explorer: { model: "vendor/explorer-only" } });

		resolveExplorerModel(runtime);
		resolveConsolidationModel(runtime);

		expect(getModel).toHaveBeenNthCalledWith(1, "openrouter", "vendor/explorer-only");
		expect(getModel).toHaveBeenNthCalledWith(2, "openrouter", "deepseek/deepseek-v4-flash-0731");
	});

	it("a malformed setting fails the resolve instead of silently using the default", () => {
		const { runtime } = runtimeWith({ consolidation: { providers: [] } });

		expect(() => resolveConsolidationModel(runtime)).toThrow(/backgroundModels\.consolidation\.providers/);
	});
});

describe("backgroundModels reaches the runtime", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "background-models-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("SettingsManager exposes the configured group, defaulting to empty", () => {
		expect(SettingsManager.inMemory({}).getBackgroundModels()).toEqual({});
		expect(
			SettingsManager.inMemory({ backgroundModels: { explorer: { model: "vendor/x" } } }).getBackgroundModels(),
		).toEqual({ explorer: { model: "vendor/x" } });
	});

	it("createAgentSessionServices hands the settings to the model runtime", async () => {
		const settingsManager = SettingsManager.inMemory({
			backgroundModels: { consolidation: { model: "vendor/from-settings", providers: ["P1"] } },
		});

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRuntime.getBackgroundModelSetting("consolidation")).toEqual({
			model: "vendor/from-settings",
			providers: ["P1"],
		});
		expect(services.modelRuntime.getBackgroundModelSetting("explorer")).toBeUndefined();
	});

	it("createAgentSession, the path the Telegram bot uses, does the same", async () => {
		const settingsManager = SettingsManager.inMemory({
			backgroundModels: { explorer: { model: "vendor/explorer-from-settings" } },
		});
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir: tempDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});

		expect(session.modelRuntime.getBackgroundModelSetting("explorer")).toEqual({
			model: "vendor/explorer-from-settings",
		});
		session.dispose();
	});
});
