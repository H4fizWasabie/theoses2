import type { Api, Model } from "theoses-ai";

/**
 * Model and provider routing for the OpenRouter-only background paths: memory consolidation (which
 * also serves the task-boundary summaries), the explorer sub-agent and the research agent. Each path
 * has defaults in code; `backgroundModels.<name>` in settings.json overrides any part of them, so
 * swapping a model or provider is a settings edit plus a restart, not a release.
 */

export type BackgroundModelName = "consolidation" | "explorer" | "research";

export interface BackgroundModelSetting {
	/** OpenRouter model id, e.g. "deepseek/deepseek-v4-flash-0731". */
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

/** The slice of ModelRuntime the resolver needs, declared here so this module does not import model-runtime.ts. */
export interface BackgroundModelSource {
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	getBackgroundModelSetting?(name: BackgroundModelName): BackgroundModelSetting | undefined;
}

/**
 * Shared defaults, overridable per name through `backgroundModels.<name>` in settings.json. The paid
 * DeepSeek V4 Flash 0731 at fp8, Baidu first and DeepInfra as the only fallback (about $0.05 to $0.06
 * per million input tokens). The free `:free` variant these used to default to was withdrawn by
 * OpenRouter on 2026-09-20, which silently stopped consolidation and task-boundary summaries until
 * the setting was overridden.
 *
 * Provider slugs must match the endpoints API's `provider_name`, not the pricing page's marketing
 * label (issues #180/#190: "Baidu Qianfan" and "AkashML" silently matched nothing): "Baidu" and
 * "DeepInfra". Baidu can answer 429 on its shared pool, which is why DeepInfra is second.
 */
const DEFAULTS: ResolvedBackgroundModelSetting = {
	model: "deepseek/deepseek-v4-flash-0731",
	providers: ["Baidu", "DeepInfra"],
	quantizations: ["fp8"],
};

/**
 * Per-name output cap. With no explicit per-request maxTokens the shared default falls back to the
 * model's full declared max completion tokens (900K+ here) clamped to context, and cheap
 * shared-capacity-pool providers reject that with `provider_error_code: "queue_timeout"`
 * (`limit_source: "upstream_provider_shared_pool"`). These are headroom for each path's real output
 * shape, not tight limits: consolidation emits one JSON object per chunk, the explorer returns
 * answers of at most 2K tokens, and research writes a longer report.
 */
const MAX_TOKENS: Record<BackgroundModelName, number> = {
	consolidation: 32000,
	explorer: 8000,
	research: 16000,
};

const LABELS: Record<BackgroundModelName, string> = {
	consolidation: "Consolidation",
	explorer: "Explorer",
	research: "Research",
};

/**
 * Resolves a background path's model from the live-hydrated OpenRouter catalog (rather than
 * hand-authoring cost/context-window numbers) and overlays cost-strict provider routing: `order`,
 * the quantization filter, and `allow_fallbacks: false`, since without that `order` is only a
 * preference and OpenRouter falls back to any other provider. A failed background pass just retries
 * later. Task-boundary summaries resolve as "consolidation" until issue #186 picks a dedicated model.
 */
export function resolveBackgroundModel(source: BackgroundModelSource, name: BackgroundModelName): Model<Api> {
	const setting = resolveBackgroundModelSetting(name, DEFAULTS, source.getBackgroundModelSetting?.(name));
	const model = source.getModel("openrouter", setting.model);
	if (!model) {
		throw new Error(
			`${LABELS[name]} model ${setting.model} not found in the OpenRouter catalog. ` +
				"Ensure the model catalog is hydrated and OpenRouter is a configured provider.",
		);
	}
	const compat = (model as Model<"openai-completions">).compat;
	return {
		...model,
		maxTokens: MAX_TOKENS[name],
		compat: {
			...compat,
			openRouterRouting: {
				...compat?.openRouterRouting,
				order: setting.providers,
				...(setting.quantizations.length > 0 ? { quantizations: setting.quantizations } : {}),
				allow_fallbacks: false,
			},
		},
	} as Model<Api>;
}
