/**
 * `excludedModels` in settings.json: patterns for models that must not be selectable at all (listing, cycling, `/model`,
 * background models, a resumed session's saved model). A pattern is tested against `provider/id` and against the bare
 * id, ignoring case, and `*` matches any characters including `/`, because ids such as
 * `deepseek/deepseek-v4.1-flash` carry a vendor prefix. Everything else in a pattern is literal.
 *
 * A pattern starting with `!` is an allow pattern with the same matching rules. A model is excluded when it matches at
 * least one exclude pattern and no allow pattern; order does not matter, and allow patterns alone exclude nothing.
 * `["*deepseek*", "!openrouter/deepseek/deepseek-v4.1-flash"]` hides every DeepSeek model but that one. An allow
 * pattern written as a bare id (`!deepseek/deepseek-v4.1-flash`) allows that id on every provider that uses it.
 */
export type ModelRef = { provider: string; id: string };

function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function isAllowPattern(pattern: string): boolean {
	return pattern.startsWith("!");
}

export function createModelExcluder(patterns: readonly string[]): (model: ModelRef) => boolean {
	const exclude = patterns.filter((p) => !isAllowPattern(p)).map(patternToRegExp);
	const allow = patterns.filter(isAllowPattern).map((p) => patternToRegExp(p.slice(1)));
	const matchesAny = (matchers: RegExp[], model: ModelRef) =>
		matchers.some((m) => m.test(`${model.provider}/${model.id}`) || m.test(model.id));
	return (model) => matchesAny(exclude, model) && !matchesAny(allow, model);
}
