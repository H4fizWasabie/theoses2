import type { Api, Model } from "theoses-ai/compat";
import { describe, expect, test } from "vitest";
import { createSessionSystemPrompt, type SessionSystemPromptSources } from "../src/core/session-system-prompt.ts";

const openRouterModel = (maxTokens = 64000) =>
	({
		id: "xiaomi/mimo-v2.6-pro",
		provider: "openrouter",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		maxTokens,
		contextWindow: 128000,
		reasoning: true,
	}) as unknown as Model<Api>;

function makeSources(overrides?: {
	workingNote?: string;
	artifactCatalog?: string;
	toolPromptSnippets?: Map<string, string>;
	toolPromptGuidelines?: Map<string, string[]>;
}): SessionSystemPromptSources {
	let workingNote = overrides?.workingNote ?? "";
	let artifactCatalog = overrides?.artifactCatalog ?? "";
	return {
		cwd: "/tmp/project",
		resourceLoader: {
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
		sessionManager: {
			getWorkingNote: () => workingNote,
			getArtifactCatalog: () => artifactCatalog,
		},
		settingsManager: {
			getThinkingBudgets: () => ({ high: 16384 }),
		},
		getToolPromptSnippets: () => overrides?.toolPromptSnippets ?? new Map(),
		getToolPromptGuidelines: () => overrides?.toolPromptGuidelines ?? new Map(),
		// test-only mutation hooks
		_setWorkingNote: (value: string) => {
			workingNote = value;
		},
		_setArtifactCatalog: (value: string) => {
			artifactCatalog = value;
		},
	} as unknown as SessionSystemPromptSources & {
		_setWorkingNote: (v: string) => void;
		_setArtifactCatalog: (v: string) => void;
	};
}

describe("session-system-prompt", () => {
	test("cold refresh builds once and includes the reasoning-budget note", () => {
		const sources = makeSources();
		const systemPrompt = createSessionSystemPrompt(sources);
		const result = systemPrompt.refresh({
			model: openRouterModel(),
			thinkingLevel: "high",
			activeTools: [],
			cacheWarm: false,
		});
		expect(result).toContain("<reasoning_budget>");
		expect(result).toContain("capped at 16384 tokens");
	});

	test("warm + model switch picks up a changed Working Note", () => {
		const sources = makeSources() as SessionSystemPromptSources & { _setWorkingNote: (v: string) => void };
		const systemPrompt = createSessionSystemPrompt(sources);
		systemPrompt.refresh({ model: openRouterModel(), thinkingLevel: "high", activeTools: [], cacheWarm: false });

		sources._setWorkingNote("fact: the sky is blue");
		const otherModel = { ...openRouterModel(), id: "other/model" };
		const result = systemPrompt.refresh({
			model: otherModel,
			thinkingLevel: "high",
			activeTools: [],
			cacheWarm: true,
		});
		expect(result).toContain("fact: the sky is blue");
	});

	test("invalidate() rebuilds even when warm", () => {
		const sources = makeSources() as SessionSystemPromptSources & { _setWorkingNote: (v: string) => void };
		const systemPrompt = createSessionSystemPrompt(sources);
		const model = openRouterModel();
		systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: false });

		sources._setWorkingNote("new note");
		systemPrompt.invalidate();
		const result = systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: true });
		expect(result).toContain("new note");
	});

	test("warm and unchanged returns the same string without rebuilding", () => {
		const sources = makeSources();
		const systemPrompt = createSessionSystemPrompt(sources);
		const model = openRouterModel();
		const first = systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: false });
		const second = systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: true });
		expect(second).toBe(first);
	});

	test("CACHE GUARD: warm turn where Working Note and artifact catalog changed returns a byte-identical string", () => {
		const sources = makeSources() as SessionSystemPromptSources & {
			_setWorkingNote: (v: string) => void;
			_setArtifactCatalog: (v: string) => void;
		};
		const systemPrompt = createSessionSystemPrompt(sources);
		const model = openRouterModel();
		const first = systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: false });

		sources._setWorkingNote("this changed but must not show up");
		sources._setArtifactCatalog("this changed too");
		const second = systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: true });
		expect(second).toBe(first);
		expect(second).not.toContain("this changed but must not show up");
	});

	test("options() includes model after invalidate()+refresh() (tool change)", () => {
		const sources = makeSources();
		const systemPrompt = createSessionSystemPrompt(sources);
		const model = openRouterModel();
		systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: [], cacheWarm: false });

		systemPrompt.invalidate();
		systemPrompt.refresh({ model, thinkingLevel: "high", activeTools: ["read"], cacheWarm: true });
		expect(systemPrompt.options().model).toBe(model);
		expect(systemPrompt.options().selectedTools).toEqual(["read"]);
	});
});
