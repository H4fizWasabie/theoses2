import type { AssistantMessage } from "theoses-ai";

/**
 * One journal line per finished model call naming the upstream provider that actually served it.
 * The routing log ("order=[Baidu -> DeepInfra]") only says who was allowed to answer; when a fallback
 * provider misbehaves (DeepInfra answering `{}` where Baidu did not, issue #315) this line is what
 * ties the bad answer to it. Silent for providers that do not report one.
 */
export function logServedProvider(message: AssistantMessage): void {
	if (!message.responseProvider) return;
	console.error(
		`[provider] served model=${message.responseModel ?? message.model} by=${message.responseProvider} ` +
			`stop=${message.stopReason} out=${message.usage.output}`,
	);
}
