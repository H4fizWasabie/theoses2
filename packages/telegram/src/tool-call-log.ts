/**
 * One journal line per finished tool call: `[tool] procura_search ok 412ms` or
 * `[tool] social_metrics_sync error 88ms: <first 200 characters of the error text>`.
 *
 * Extensions catch their own failures and hand them back as ordinary tool-result text (procura returns
 * `{error: message}`, social-metrics returns "... failed: msg"), so the model and the user see them but the
 * journal never did: three days of production journal held no tool or extension line at all. Logging here
 * covers every extension at once without editing any of them. Journal only; nothing is added to the request,
 * so prompt caching is unaffected.
 */
const ERROR_TEXT_LIMIT = 200;

/** Best-effort text of a tool result (`{content: [{type: "text", text}]}` or a plain string). */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join(" ");
}

export function createToolCallLogger(now: () => number = Date.now, log: (line: string) => void = console.error) {
	const startedAt = new Map<string, number>();
	return {
		start(toolCallId: string): void {
			startedAt.set(toolCallId, now());
		},
		end(event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }): void {
			const started = startedAt.get(event.toolCallId);
			startedAt.delete(event.toolCallId);
			const elapsed = started === undefined ? "?" : `${now() - started}`;
			const outcome = event.isError ? "error" : "ok";
			const detail = event.isError
				? `: ${resultText(event.result).replace(/\s+/g, " ").trim().slice(0, ERROR_TEXT_LIMIT)}`
				: "";
			log(`[tool] ${event.toolName} ${outcome} ${elapsed}ms${detail}`);
		},
	};
}
