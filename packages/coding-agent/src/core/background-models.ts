/**
 * Model and provider routing for the OpenRouter-only background paths: memory consolidation (which
 * also serves compaction-adjacent task-boundary summaries) and the explorer sub-agent. Each path has
 * defaults in code; `backgroundModels.<name>` in settings.json overrides any part of them, so
 * swapping a model or provider is a settings edit plus a restart, not a release.
 */

export type BackgroundModelName = "consolidation" | "explorer";

export interface BackgroundModelSetting {
	/** OpenRouter model id, e.g. "deepseek/deepseek-v4-flash-0731:free". */
	model?: string;
	/**
	 * OpenRouter provider `order`, using the endpoints API's `provider_name` (not the pricing page's
	 * marketing label). Requests fail rather than fall back to a provider outside this list.
	 */
	providers?: string[];
	/** Accepted quantizations, e.g. ["fp8"]. An empty list turns the filter off. */
	quantizations?: string[];
}

export type BackgroundModelConfig = Partial<Record<BackgroundModelName, BackgroundModelSetting>>;

export interface ResolvedBackgroundModelSetting {
	model: string;
	providers: string[];
	quantizations: string[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Applies a settings override on top of a background path's code defaults. Malformed values throw
 * with the setting's path so a typo shows up in the journal instead of silently falling back.
 */
export function resolveBackgroundModelSetting(
	name: BackgroundModelName,
	defaults: ResolvedBackgroundModelSetting,
	override: unknown,
): ResolvedBackgroundModelSetting {
	if (override === undefined || override === null) return defaults;
	const where = `settings.json backgroundModels.${name}`;
	if (typeof override !== "object" || Array.isArray(override)) {
		throw new Error(`${where} must be an object with model, providers and/or quantizations`);
	}
	const { model, providers, quantizations } = override as Record<string, unknown>;

	if (model !== undefined && !isNonEmptyString(model)) {
		throw new Error(`${where}.model must be a non-empty OpenRouter model id`);
	}
	if (
		providers !== undefined &&
		(!Array.isArray(providers) || providers.length === 0 || !providers.every(isNonEmptyString))
	) {
		// An empty order would let OpenRouter pick any provider, which defeats the cost-strict routing.
		throw new Error(`${where}.providers must be a non-empty list of provider names`);
	}
	if (quantizations !== undefined && (!Array.isArray(quantizations) || !quantizations.every(isNonEmptyString))) {
		throw new Error(`${where}.quantizations must be a list of quantization names (empty to disable the filter)`);
	}

	return {
		model: model ?? defaults.model,
		providers: providers ?? defaults.providers,
		quantizations: quantizations ?? defaults.quantizations,
	};
}
