/**
 * Shared runner core for background sub-agents (explorer.ts, researcher.ts): an isolated `Agent`
 * with a turns/input-token budget, provider-hook wiring (so cost-watch sees its traffic under its
 * own model), and abort-signal plumbing. Deliberately does not cover consolidation's
 * modelRuntime.completeSimple() calls - that bypass of extension hooks is its own documented
 * decision (see memory-consolidation.ts), not a duplicate of this.
 *
 * Each caller keeps what's actually different about it on top of the returned handle: explorer
 * subscribes to `agent` itself for its live status line and enforces its own line cap on the
 * answer; researcher composes its own abort signal (caller signal + a timeout). Each decides
 * what counts as an answer (`isAnswer`) and passes its own finalize prompt to `promptToAnswer()`,
 * which owns the rest: the tool-free finalize turn when the first prompt ends without one.
 * `prompt()` accumulates turns/tokens across repeat calls rather than resetting them, so that
 * finalize turn still counts against the same budget as the first prompt.
 */

import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTool,
	type ThinkingLevel,
} from "theoses-agent-core";
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
	/** Defaults to "off", right for a cheap scouting model; a sub-agent doing the parent's own work passes the parent's level. */
	thinkingLevel?: ThinkingLevel;
	/** Runs before every tool call of the sub-agent; a sub-agent that changes files uses the parent's own gate. */
	beforeToolCall?: AgentOptions["beforeToolCall"];
}

export interface BudgetedAgentTurnStats {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	/** True once maxTurns or maxInputTokens was hit - the caller's INCOMPLETE contract, not this module's. */
	stoppedByBudget: boolean;
}

export interface PromptToAnswerOptions {
	/** Sent as one extra turn with no tools when the first prompt did not end in an answer. */
	finalizePrompt: string;
	/** The caller's judgment of what counts as an answer, given the last assistant text and the stats so far. */
	isAnswer: (text: string, stats: BudgetedAgentTurnStats) => boolean;
}

export interface PromptedAnswer {
	/** The last assistant text after the run, including the finalize turn if there was one. */
	text: string;
	/** Accumulated over the first prompt and the finalize turn. */
	stats: BudgetedAgentTurnStats;
	/** True when the first prompt did not end in an answer and the finalize turn ran. */
	finalized: boolean;
	/** The budget limits the first prompt reached, e.g. "30-turn cap"; empty when none. */
	stoppedBy: string[];
}

export interface BudgetedAgentHandle {
	/** The underlying Agent, for a caller that needs its own subscription (e.g. explorer's onStatus). */
	agent: Agent;
	/**
	 * Run one prompt to completion. Turns/tokens accumulate across repeat calls on the same
	 * handle (a finalize prompt counts against the same budget as the first prompt).
	 */
	prompt(text: string): Promise<BudgetedAgentTurnStats>;
	/**
	 * Run one prompt; if it does not end in an answer (the caller decides what that is), give the agent one
	 * last turn with no tools to write one up from what it has read. It runs after a cap on purpose: a cap
	 * must never be the reason the caller gets nothing. Skipped once the signal has aborted.
	 */
	promptToAnswer(text: string, options: PromptToAnswerOptions): Promise<PromptedAnswer>;
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
			thinkingLevel: options.thinkingLevel ?? "off",
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
		beforeToolCall: options.beforeToolCall,
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
			const usage = (event.message as AssistantMessage).usage;
			if (usage) {
				// Issue #390: `input` excludes cached tokens, and a multi-turn sub-agent resends its context mostly as cache reads.
				inputTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				outputTokens += usage.output ?? 0;
			}
		}
	});

	if (options.signal) {
		options.signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	const prompt = async (text: string): Promise<BudgetedAgentTurnStats> => {
		await agent.prompt(text);
		return { turns, inputTokens, outputTokens, stoppedByBudget };
	};

	return {
		agent,
		prompt,
		async promptToAnswer(text, { finalizePrompt, isAnswer }) {
			let stats = await prompt(text);
			const stoppedBy = stats.stoppedByBudget
				? [
						turns >= options.maxTurns && `${options.maxTurns}-turn cap`,
						inputTokens >= options.maxInputTokens && `${options.maxInputTokens / 1000}K input-token cap`,
					].filter((limit): limit is string => typeof limit === "string")
				: [];
			let finalized = false;
			if (!options.signal?.aborted && !isAnswer(lastAssistantText(agent.state.messages), stats)) {
				finalized = true;
				agent.state.tools = [];
				stats = await prompt(finalizePrompt);
			}
			return { text: lastAssistantText(agent.state.messages), stats, finalized, stoppedBy };
		},
	};
}
