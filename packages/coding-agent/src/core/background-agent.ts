/**
 * Shared runner core for sub-agents (explorer.ts, researcher.ts, task-agent.ts, plan-reviewer.ts): an isolated
 * `Agent` with a turns/input-token budget, provider-hook wiring (so cost-watch sees its traffic under its own
 * model), abort-signal plumbing, a live status line and a line cap. Deliberately does not cover consolidation's
 * modelRuntime.completeSimple() calls - that bypass of extension hooks is its own documented decision (see
 * memory-consolidation.ts), not a duplicate of this.
 *
 * `promptToAnswer()` owns what a run ended with: whether the agent answered (its last message is an assistant
 * message with text and no tool call, and the caller's `isAnswer` accepts the text), the tool-free finalize turn
 * when it did not, and the status: complete, partial (a cap or abort cut it short) or none. Each caller keeps
 * only its prompts, its tools, what counts as an answer, and how it words the result. `prompt()` accumulates
 * turns/tokens across repeat calls rather than resetting them, so the finalize turn counts against the same
 * budget as the first prompt.
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

/**
 * The text of the run's final message when that message is an assistant reply with no tool call, else "". A cap
 * stops the loop after a turn's tool results, so a capped run ends on a tool result: the narration beside its last
 * tool call ("Let me run the tests.") is not an answer, though `lastAssistantText` would return it.
 */
function finalReplyText(messages: AgentMessage[]): string {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || endedOnToolCall(messages)) return "";
	return lastAssistantText([last]);
}

function capLines(text: string, maxLines: number | undefined): string {
	const lines = text.split("\n");
	if (maxLines === undefined || lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n[truncated by harness: exceeded ${maxLines} lines]`;
}

function summarizeArgs(args: unknown): string {
	try {
		return (JSON.stringify(args) ?? "").slice(0, 120);
	} catch {
		return "";
	}
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
	/** Runs after every tool call of the sub-agent; a sub-agent doing the parent's work uses the parent's own hooks. */
	afterToolCall?: AgentOptions["afterToolCall"];
	/** Called with "<tool>: <args, first 120 chars>" as each tool call starts, for a live status line. */
	onStatus?: (status: string) => void;
	/** Truncates the text `promptToAnswer` returns to this many lines, with a note saying so. */
	capLines?: number;
}

export interface BudgetedAgentTurnStats {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	/** Total cost of the run's assistant messages, from their reported usage. */
	cost: number;
	/** True once maxTurns or maxInputTokens was hit. */
	stoppedByBudget: boolean;
}

export interface PromptToAnswerOptions {
	/** Sent as one extra turn with no tools when the first prompt did not end in an answer. */
	finalizePrompt: string;
	/**
	 * The caller's judgment of whether the final reply's text counts as an answer, given the stats so far. Only
	 * asked about a final assistant reply with text and no tool call; anything else is never an answer. Without it,
	 * every such reply is one.
	 */
	isAnswer?: (text: string, stats: BudgetedAgentTurnStats) => boolean;
}

/**
 * complete: answered, and no cap or abort cut the run short (an answer written in the finalize turn counts when
 * the model had only stopped to narrate, and one written on the last allowed turn counts too). partial: answered
 * only in the finalize turn a cap forced, or the signal aborted. none: no answer.
 */
export type AnswerStatus = "complete" | "partial" | "none";

export interface PromptedAnswer {
	status: AnswerStatus;
	/** The answer (line-capped) when there is one; otherwise the last assistant text, as notes. */
	text: string;
	/** Accumulated over the first prompt and the finalize turn. */
	stats: BudgetedAgentTurnStats;
	/** True when the first prompt did not end in an answer and the finalize turn ran. */
	finalized: boolean;
	/** The budget limits the first prompt reached, e.g. "30-turn cap"; empty when none. */
	stoppedBy: string[];
}

export interface BudgetedAgentHandle {
	/** The underlying Agent, for a caller that needs its own state or subscription. */
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
	let cost = 0;
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
		afterToolCall: options.afterToolCall,
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
				cost += usage.cost?.total ?? 0;
			}
		} else if (event.type === "tool_execution_start") {
			options.onStatus?.(`${event.toolName}: ${summarizeArgs(event.args)}`);
		}
	});

	if (options.signal) {
		options.signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	const prompt = async (text: string): Promise<BudgetedAgentTurnStats> => {
		await agent.prompt(text);
		return { turns, inputTokens, outputTokens, cost, stoppedByBudget };
	};

	const answerOf = (stats: BudgetedAgentTurnStats, isAnswer: PromptToAnswerOptions["isAnswer"]) => {
		const reply = finalReplyText(agent.state.messages);
		return reply.length > 0 && (isAnswer?.(reply, stats) ?? true) ? reply : undefined;
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
			let answer = answerOf(stats, isAnswer);
			let finalized = false;
			if (answer === undefined && !options.signal?.aborted) {
				finalized = true;
				agent.state.tools = [];
				stats = await prompt(finalizePrompt);
				answer = answerOf(stats, isAnswer);
			}
			if (answer === undefined) {
				return { status: "none", text: lastAssistantText(agent.state.messages), stats, finalized, stoppedBy };
			}
			// A cap that fired on the turn the agent answered cut nothing off; only one that forced the finalize turn did.
			const cutShort = (finalized && stoppedBy.length > 0) || options.signal?.aborted === true;
			return {
				status: cutShort ? "partial" : "complete",
				text: capLines(answer, options.capLines),
				stats,
				finalized,
				stoppedBy,
			};
		},
	};
}
