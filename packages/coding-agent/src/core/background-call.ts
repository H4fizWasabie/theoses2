import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, type RetryPolicy, retryAssistantCall } from "theoses-ai";
import { type Context, isRetryableAssistantError, type SimpleStreamOptions } from "theoses-ai/compat";
import { getAgentDir } from "../config.ts";
import { type BackgroundModelName, resolveBackgroundModel } from "./background-models.ts";
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
 *
 * A transient error that outlasts the retries (most often a 429 from the consolidation model's single
 * upstream: 18 lost passes in the week to 2026-10-06) gets one more pass on the fallback model, a
 * different provider, instead of dropping the window.
 */
export async function backgroundCall(
	modelRuntime: ModelRuntime,
	options: BackgroundCallOptions,
): Promise<AssistantMessage> {
	const response = await callModel(modelRuntime, "consolidation", options);
	if (!isRetryableAssistantError(response)) return response;
	return callModel(modelRuntime, "fallback", options);
}

async function callModel(
	modelRuntime: ModelRuntime,
	name: BackgroundModelName,
	options: BackgroundCallOptions,
): Promise<AssistantMessage> {
	const model = resolveBackgroundModel(modelRuntime, name);
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
