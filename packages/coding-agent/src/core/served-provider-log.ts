import { type AssistantMessage, STOP_WITHOUT_TOOL_CALL_DIAGNOSTIC } from "theoses-ai";
import { recordBackgroundFailure } from "./background-failure-log.ts";

/**
 * One journal line per finished model call naming the upstream provider that actually served it.
 * The routing log ("order=[Baidu -> DeepInfra]") only says who was allowed to answer; when a fallback
 * provider misbehaves (DeepInfra answering `{}` where Baidu did not, issue #315) this line is what
 * ties the bad answer to it. Silent for providers that do not report one.
 */
export function logServedProvider(message: AssistantMessage): void {
	reportStopWithoutToolCall(message);
	if (!message.responseProvider) return;
	console.error(
		`[provider] served model=${message.responseModel ?? message.model} by=${message.responseProvider} ` +
			`stop=${message.stopReason} out=${message.usage.output}`,
	);
}

/**
 * A turn that ends with `stop` after billing far more output tokens than its visible text ends the whole task
 * (the agent loop only continues on a tool call), so the user has to type "Proceed". Logs it and keeps the
 * stream's chunk tail in failed-background-responses.jsonl to show what the provider actually sent.
 */
function reportStopWithoutToolCall(message: AssistantMessage): void {
	const diagnostic = message.diagnostics?.find((d) => d.type === STOP_WITHOUT_TOOL_CALL_DIAGNOSTIC);
	if (!diagnostic) return;
	const model = message.responseModel ?? message.model;
	console.error(
		`[stall] turn ended with stop and no tool call but billed ${message.usage.output} output tokens ` +
			`model=${model} by=${message.responseProvider ?? "unknown"}: ${JSON.stringify(diagnostic.details)}`,
	);
	recordBackgroundFailure({
		caller: "main-agent-stop-without-tool-call",
		model,
		provider: message.responseProvider,
		stopReason: message.stopReason,
		error: JSON.stringify(diagnostic.details),
		reply: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
	});
}
