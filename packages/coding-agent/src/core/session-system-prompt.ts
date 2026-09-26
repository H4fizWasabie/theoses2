import type { ThinkingLevel } from "theoses-agent-core";
import type { Model } from "theoses-ai/compat";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";

/** What a rebuild needs from the turn currently starting. */
export interface SystemPromptRefreshInput {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel;
	/** Tool names active for the coming turn (already filtered to real, registered tools). */
	activeTools: string[];
	/** Whether the provider's prompt cache for the current prefix is probably still warm (see AgentSession._isPromptCacheWarm). */
	cacheWarm: boolean;
}

/** Everything a rebuild reads, owned by AgentSession and handed over as closures so a swapped registry/reload is always seen live. */
export interface SessionSystemPromptSources {
	cwd: string;
	resourceLoader: Pick<ResourceLoader, "getSystemPrompt" | "getAppendSystemPrompt" | "getSkills" | "getAgentsFiles">;
	sessionManager: Pick<SessionManager, "getWorkingNote" | "getArtifactCatalog">;
	settingsManager: Pick<SettingsManager, "getThinkingBudgets">;
	getToolPromptSnippets(): Map<string, string>;
	getToolPromptGuidelines(): Map<string, string[]>;
}

/**
 * Owns the session's system prompt: the one rebuild rule (cold cache, model/thinking-level change, or an explicit
 * invalidate — nothing else), and the cached string/options a warm, unchanged turn returns byte-identical, since
 * provider prompt caching keys off the system prompt being stable across turns.
 */
export interface SessionSystemPrompt {
	/** Rebuilds when needed, otherwise returns the cached string unchanged. Call once per operation, before the
	 * prompt is handed to extensions or the model. */
	refresh(input: SystemPromptRefreshInput): string;
	/** Marks the cached prompt stale (active tools or loaded resources changed) without rebuilding. The next
	 * refresh() call picks it up, regardless of cache warmth. */
	invalidate(): void;
	/** The complete options behind the last built string (always includes model/thinkingLevel/thinkingBudgets). */
	options(): BuildSystemPromptOptions;
}

export function createSessionSystemPrompt(sources: SessionSystemPromptSources): SessionSystemPrompt {
	let dirty = true;
	let lastModel: Model<any> | undefined;
	let lastThinkingLevel: ThinkingLevel | undefined;
	let prompt = "";
	let options: BuildSystemPromptOptions | undefined;

	function rebuild(input: SystemPromptRefreshInput): string {
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		const toolPromptSnippets = sources.getToolPromptSnippets();
		const toolPromptGuidelines = sources.getToolPromptGuidelines();
		for (const name of input.activeTools) {
			const snippet = toolPromptSnippets.get(name);
			if (snippet) toolSnippets[name] = snippet;
			const guidelines = toolPromptGuidelines.get(name);
			if (guidelines) promptGuidelines.push(...guidelines);
		}

		const loaderAppendSystemPrompt = sources.resourceLoader.getAppendSystemPrompt();

		options = {
			cwd: sources.cwd,
			skills: sources.resourceLoader.getSkills().skills,
			contextFiles: sources.resourceLoader.getAgentsFiles().agentsFiles,
			customPrompt: sources.resourceLoader.getSystemPrompt(),
			appendSystemPrompt: loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined,
			selectedTools: input.activeTools,
			toolSnippets,
			promptGuidelines,
			workingNote: sources.sessionManager.getWorkingNote(),
			artifactCatalog: sources.sessionManager.getArtifactCatalog(),
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			thinkingBudgets: sources.settingsManager.getThinkingBudgets(),
		};
		return buildSystemPrompt(options);
	}

	return {
		refresh(input) {
			const needsRebuild =
				dirty || !input.cacheWarm || lastModel !== input.model || lastThinkingLevel !== input.thinkingLevel;
			if (needsRebuild) {
				prompt = rebuild(input);
				dirty = false;
				lastModel = input.model;
				lastThinkingLevel = input.thinkingLevel;
			}
			return prompt;
		},
		invalidate() {
			dirty = true;
		},
		options() {
			// Only unset before the first refresh() call, which every real entry point performs before reading options().
			return options!;
		},
	};
}
