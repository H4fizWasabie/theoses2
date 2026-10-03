import type { ThinkingLevel } from "theoses-agent-core";
import type { Api } from "theoses-ai";
import { clampThinkingLevel, type Model } from "theoses-ai/compat";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

/**
 * The thinking level a session runs at, whichever way it is being set up. Each caller supplies only the sources
 * that apply to it: session startup has `saved` (the level of a resumed session) and no `current`; a Model Switch
 * has `current` and no `saved`. The sources are tried in the order they are declared below.
 */
export interface ThinkingLevelSources {
	/** No model means no thinking: the result is "off". */
	model: Model<Api> | undefined;
	/** A level the caller was told to use (SDK option, a scoped model's own level). */
	explicit?: ThinkingLevel;
	/** The level a resumed session last ran at. */
	saved?: ThinkingLevel;
	/** The `modelThinkingLevels` setting for this model. */
	perModel?: ThinkingLevel;
	/** The `defaultThinkingLevel` setting. */
	globalDefault?: ThinkingLevel;
	/** The level the session is running at now. */
	current?: ThinkingLevel;
}

/** The first source that is set, else `DEFAULT_THINKING_LEVEL`, clamped to what the model supports. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel {
	if (!sources.model) return "off";
	const level =
		sources.explicit ??
		sources.saved ??
		sources.perModel ??
		sources.globalDefault ??
		sources.current ??
		DEFAULT_THINKING_LEVEL;
	return clampThinkingLevel(sources.model, level) as ThinkingLevel;
}
