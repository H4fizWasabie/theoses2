/**
 * Shared runner core for background sub-agents (explorer.ts, researcher.ts): an isolated `Agent`
 * with a turns/input-token budget, provider-hook wiring (so cost-watch sees its traffic under its
 * own model), and abort-signal plumbing. Deliberately does not cover consolidation's
 * modelRuntime.completeSimple() calls - that bypass of extension hooks is its own documented
 * decision (see memory-consolidation.ts), not a duplicate of this.
 *
 * Each caller keeps what's actually different about it on top of the returned handle: explorer
 * subscribes to `agent` itself for its live status line and enforces its own line cap on the
 * answer; researcher composes its own abort signal (caller signal + a timeout) and issues a
 * second "finalize" prompt through the same handle when the first one ends without a report -
 * `prompt()` accumulates turns/tokens across repeat calls rather than resetting them, so that
 * second call still counts against the same budget as the first.
 */

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "theoses-agent-core";
import type { Api, AssistantMessage, Model, ModelsRequestTransforms } from "theoses-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProviderHooks } from "./provider-hooks.ts";
import { logServedProvider } from "./served-provider-log.ts";

export function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export function endedOnToolCall(messages: AgentMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall");
}

export interface CreateBudgetedAgentOptions {
	systemPrompt: string;
	model: Model<Api>;
	tools: AgentTool<any>[];
	modelRuntime: ModelRuntime;
	maxTurns: number;
	maxInputTokens: number;
	signal?: AbortSignal;
	/** Issue #260/#263: the session's provider hooks, so cost-watch sees this sub-agent's traffic under its own model. */
	providerHooks?: ProviderHooks;
}

export interface BudgetedAgentTurnStats {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	/** True once maxTurns or maxInputTokens was hit - the caller's INCOMPLETE contract, not this module's. */
	stoppedByBudget: boolean;
}

export interface BudgetedAgentHandle {
	/** The underlying Agent, for a caller that needs its own subscription (e.g. explorer's onStatus). */
	agent: Agent;
	/**
	 * Run one prompt to completion. Turns/tokens accumulate across repeat calls on the same
	 * handle (researcher's finalize prompt counts against the same budget as its first prompt).
	 */
	prompt(text: string): Promise<BudgetedAgentTurnStats>;
}

export function createBudgetedAgent(options: CreateBudgetedAgentOptions): BudgetedAgentHandle {
	let turns = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let stoppedByBudget = false;
	const hooks = options.providerHooks;

	const agent: Agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt,
			model: options.model,
			thinkingLevel: "off",
			tools: options.tools,
		},
		streamFn: (streamModel, context, streamOptions) =>
			options.modelRuntime.streamSimple(streamModel, context, {
				...streamOptions,
				// AgentLoopConfig doesn't carry transformHeaders (the loop spreads it into streamFn
				// options via `...config`), so inject it here like sdk.ts's wrapper does.
				transformHeaders: hooks
					? (headers) => hooks.transformHeaders(headers, streamModel)
					: (streamOptions as ModelsRequestTransforms | undefined)?.transformHeaders,
			}),
		onPayload: hooks?.onPayload,
		onResponse: hooks?.onResponse,
		shouldStopAfterTurn: () => {
			turns++;
			if (turns >= options.maxTurns || inputTokens >= options.maxInputTokens) {
				stoppedByBudget = true;
				return true;
			}
			return false;
		},
	});

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			// streamSimple, unlike ModelRuntime's complete* paths, does not log the serving provider itself.
			logServedProvider(event.message as AssistantMessage);
			const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
			if (usage) {
				inputTokens += usage.input ?? 0;
				outputTokens += usage.output ?? 0;
			}
		}
	});

	if (options.signal) {
		options.signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	return {
		agent,
		async prompt(text: string): Promise<BudgetedAgentTurnStats> {
			await agent.prompt(text);
			return { turns, inputTokens, outputTokens, stoppedByBudget };
		},
	};
}
