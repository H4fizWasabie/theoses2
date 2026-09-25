import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, type RetryPolicy, retryAssistantCall } from "theoses-ai";
import type { Context, SimpleStreamOptions } from "theoses-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolveBackgroundModel } from "./background-models.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export interface BackgroundCallOptions {
	/** Labels the cost-log line. */
	caller: "consolidation" | "task-boundary";
	prompt: string;
	/** Provider session affinity, so repeat calls for one Channel Session can reuse a prompt cache. */
	sessionId: string;
	retry: RetryPolicy;
	responseFormat?: SimpleStreamOptions["responseFormat"];
}

/**
 * One non-agentic background model call (memory consolidation, the task-boundary summary): the
 * consolidation-tier background model, one user message, tools off, transient errors retried, and the
 * cost logged. These calls never land in a session file, so a daily cost report scanning session files
 * would miss them; `consolidation-usage.jsonl` (one `{timestamp, cost, model, caller}` line per call) is
 * where it totals them. The served-provider journal line comes from `modelRuntime.completeSimple`
 * itself. Prompt wording, and what counts as a usable answer, stay with each caller.
 */
export async function backgroundCall(
	modelRuntime: ModelRuntime,
	options: BackgroundCallOptions,
): Promise<AssistantMessage> {
	const model = resolveBackgroundModel(modelRuntime, "consolidation");
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: options.prompt }], timestamp: Date.now() }],
	};
	// No `reasoning` option: omitting it lands the model in its off/disabled state on the wire for every
	// thinkingFormat that supports one (issue #177).
	const streamOptions: SimpleStreamOptions = {
		maxTokens: model.maxTokens,
		toolChoice: "none",
		sessionId: options.sessionId,
		...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
	};
	const response = await retryAssistantCall(
		() => modelRuntime.completeSimple(model, context, streamOptions),
		options.retry,
		undefined,
	);
	if (typeof response.usage?.cost?.total === "number") {
		logBackgroundCost(response.usage.cost.total, response.responseModel ?? model.id, options.caller);
	}
	return response;
}

function logBackgroundCost(cost: number, model: string, caller: BackgroundCallOptions["caller"]): void {
	try {
		const path = join(getAgentDir(), "consolidation-usage.jsonl");
		appendFileSync(path, `${JSON.stringify({ timestamp: Date.now(), cost, model, caller })}\n`);
	} catch (error) {
		console.error("Background call usage log write failed:", error instanceof Error ? error.message : error);
	}
}
