/**
 * `excludedModels` in settings.json: patterns for models that must not be selectable at all (listing, cycling, `/model`,
 * background models, a resumed session's saved model). A pattern is tested against `provider/id` and against the bare
 * id, ignoring case, and `*` matches any characters including `/`, because ids such as
 * `deepseek/deepseek-v4.1-flash` carry a vendor prefix. Everything else in a pattern is literal.
 */
export type ModelRef = { provider: string; id: string };

function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function createModelExcluder(patterns: readonly string[]): (model: ModelRef) => boolean {
	const matchers = patterns.map(patternToRegExp);
	return (model) => matchers.some((m) => m.test(`${model.provider}/${model.id}`) || m.test(model.id));
}
