/**
 * Deep-research sub-agent.
 *
 * Sibling of explorer.ts, but for the web instead of the codebase. Like the explorer it runs inline:
 * the `research` tool call blocks until the job finishes and returns the report as its result, so the
 * main model relays it in the same turn. (An earlier asynchronous design delivered the report later
 * as a follow-up message; a turn started that way had no channel adapter listening, so its reply
 * never reached the user.) The agent loop uses the same OpenRouter background-model slot machinery
 * as the explorer (`backgroundModels.research`), with Tavily search and extract as its only tools.
 *
 * The agent decides when to call it, so safety is harness-side caps: per-job turns, input tokens,
 * Tavily calls and wall-clock time, plus per-session concurrency and job-count limits.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "theoses-agent-core";
import type { Api, Model, ModelsRequestTransforms, ProviderHeaders, SimpleStreamOptions } from "theoses-ai";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import { resolveBackgroundModel } from "./background-models.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";
import { createWebExtractToolDefinition, createWebSearchToolDefinition } from "./tools/web-search.ts";

// ponytail: guessed caps, tune after real runs.
export const RESEARCH_CAPS = {
	maxTurns: 20,
	maxInputTokens: 600_000,
	maxTavilyCalls: 15,
	timeoutMs: 10 * 60_000,
	maxConcurrent: 2,
	maxPerSession: 5,
} as const;

/** Chars of the report returned into context; the full report is always written to a file. */
const DELIVERED_REPORT_CHARS = 20_000;

/** The system prompt's report format opens with a "Summary" section; narration mid-job does not. */
function looksLikeReport(text: string): boolean {
	return /^\W*summary\b/im.test(text);
}

const FINALIZE_PROMPT =
	'Stop researching. Write the final report now from what you have gathered, in the required format ("Summary", "Findings", "Gaps"). Do not call any tools.';

const RESEARCH_SYSTEM_PROMPT = `You are Theoses's background research agent: an isolated agent that answers ONE research question from the web, then returns a written report.

Tools: web_search (snippets and links) and web_extract (full text of one page). Search first, extract only the most relevant pages, cross-check important claims across sources.

Hard limits: at most ${RESEARCH_CAPS.maxTurns} turns, ~${RESEARCH_CAPS.maxInputTokens / 1000}K input tokens and ${RESEARCH_CAPS.maxTavilyCalls} search/extract calls in total. When a tool tells you the search budget is spent, stop searching and write the report from what you have.

Report format (markdown):
1. "Summary": at most 12 lines that directly answer the question.
2. "Findings": the supporting detail, grouped by topic. Every claim carries its source URL.
3. "Gaps": what you could not verify or find.
Never invent sources or specifics. If sources disagree, say so.`;

function lastAssistantText(messages: AgentMessage[]): string {
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

function endedOnToolCall(messages: AgentMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall");
}

/** Tavily tools that refuse after `max` calls in one job, so the Tavily bill is capped independently of tokens. */
function withCallBudget(tool: ToolDefinition<any, any>, budget: { used: number }): ToolDefinition<any, any> {
	return {
		...tool,
		execute: (id, params, signal, onUpdate, ctx) => {
			if (budget.used >= RESEARCH_CAPS.maxTavilyCalls) {
				throw new Error("Search budget spent. Stop searching and write the report from what you have.");
			}
			budget.used++;
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	};
}

export interface ResearchResult {
	report: string;
	/** false when a cap or the timeout cut the job short. */
	complete: boolean;
	turnsUsed: number;
	inputTokens: number;
}

export interface RunResearchOptions {
	question: string;
	modelRuntime: ModelRuntime;
	signal?: AbortSignal;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	transformHeaders?: (headers: ProviderHeaders, model?: Model<Api>) => ProviderHeaders | Promise<ProviderHeaders>;
}

export async function runResearch(options: RunResearchOptions): Promise<ResearchResult> {
	const model = resolveBackgroundModel(options.modelRuntime, "research");
	const budget = { used: 0 };
	const tools = [createWebSearchToolDefinition(), createWebExtractToolDefinition()].map((tool) =>
		wrapToolDefinition(withCallBudget(tool, budget)),
	);

	let turns = 0;
	let inputTokens = 0;
	let stoppedByBudget = false;

	const agent: Agent = new Agent({
		initialState: { systemPrompt: RESEARCH_SYSTEM_PROMPT, model, thinkingLevel: "off", tools },
		streamFn: (streamModel, context, streamOptions) =>
			options.modelRuntime.streamSimple(streamModel, context, {
				...streamOptions,
				transformHeaders: options.transformHeaders
					? (headers) => options.transformHeaders?.(headers ?? {}, model) ?? headers ?? {}
					: (streamOptions as ModelsRequestTransforms | undefined)?.transformHeaders,
			}),
		onPayload: options.onPayload,
		onResponse: options.onResponse,
		shouldStopAfterTurn: () => {
			turns++;
			if (turns >= RESEARCH_CAPS.maxTurns || inputTokens >= RESEARCH_CAPS.maxInputTokens) {
				stoppedByBudget = true;
				return true;
			}
			return false;
		},
	});

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			inputTokens += (event.message as { usage?: { input?: number } }).usage?.input ?? 0;
		}
	});

	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(RESEARCH_CAPS.timeoutMs)])
		: AbortSignal.timeout(RESEARCH_CAPS.timeoutMs);
	signal.addEventListener("abort", () => agent.abort(), { once: true });

	try {
		await agent.prompt(options.question);
		// The model can end a turn with narration and no tool call ("Let me extract a few pages...");
		// the loop then stops without a report. Give it one turn to write it up from what it has.
		if (!stoppedByBudget && !signal.aborted && !looksLikeReport(lastAssistantText(agent.state.messages))) {
			await agent.prompt(FINALIZE_PROMPT);
		}
	} finally {
		unsubscribe();
	}

	const text = lastAssistantText(agent.state.messages);
	const complete =
		!stoppedByBudget && !signal.aborted && !endedOnToolCall(agent.state.messages) && looksLikeReport(text);
	const report = complete
		? text
		: `INCOMPLETE: the job hit its budget or timeout before finishing.${text ? `\n\nLast notes:\n${text}` : ""}`;
	return { report, complete, turnsUsed: turns, inputTokens };
}

/** Per-session job accounting. One instance lives on the AgentSession so runtime rebuilds don't reset it. */
export class ResearchJobs {
	running = 0;
	started = 0;
}

const researchSchema = Type.Object({
	question: Type.String({
		description: "The research question, self-contained (the researcher sees nothing of this conversation)",
	}),
});
type ResearchInput = Static<typeof researchSchema>;

export interface ResearchToolDeps {
	modelRuntime: ModelRuntime;
	jobs: ResearchJobs;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	transformHeaders?: (headers: ProviderHeaders, model?: Model<Api>) => ProviderHeaders | Promise<ProviderHeaders>;
}

function saveReport(id: string, question: string, report: string): string {
	const dir = join(getAgentDir(), "research");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.md`);
	writeFileSync(path, `# ${question}\n\n${report}\n`);
	return path;
}

export function createResearchToolDefinition(deps: ResearchToolDeps): ToolDefinition<typeof researchSchema> {
	const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
	return {
		name: "research",
		label: "research",
		description:
			"Run a deep web-research sub-agent (searches and reads many sources, cross-checks them, writes a cited report) and return its report. Blocks until the job finishes, typically 1-3 minutes and at most 10. Use for open-ended, multi-source questions (comparisons, current state of a topic, market or technical surveys). Do NOT use for a single fact (use web_search) or for questions about the codebase (use explore). Each job costs real money.",
		promptSnippet: "Run a multi-source web research sub-agent and get its cited report back",
		promptGuidelines: [
			"Use `research` only when the question needs many sources or cross-checking. Single facts belong to `web_search`, code questions to `explore`.",
			"`research` blocks until the report is ready. Give the user the report's findings yourself in the same reply (Summary, key findings, gaps); the saved file path is only a footnote, never the deliverable.",
		],
		parameters: researchSchema,
		execute: async (_toolCallId, { question }: ResearchInput, signal) => {
			const { jobs } = deps;
			if (jobs.running >= RESEARCH_CAPS.maxConcurrent) {
				return reply(
					`Not started: ${RESEARCH_CAPS.maxConcurrent} research jobs are already running. Wait for one to finish.`,
				);
			}
			if (jobs.started >= RESEARCH_CAPS.maxPerSession) {
				return reply(`Not started: this session already used its ${RESEARCH_CAPS.maxPerSession} research jobs.`);
			}
			const id = `r${++jobs.started}`;
			jobs.running++;
			try {
				const result = await runResearch({ ...deps, question, signal });
				const path = saveReport(id, question, result.report);
				const body = result.report.slice(0, DELIVERED_REPORT_CHARS);
				const cut =
					result.report.length > body.length ? `\n[truncated, full report: ${path}]` : `\n[saved: ${path}]`;
				return reply(
					`Research job ${id} finished (${result.turnsUsed} turns, ${Math.round(result.inputTokens / 1000)}K in). Question: ${question}\n\n${body}${cut}`,
				);
			} finally {
				jobs.running--;
			}
		},
	};
}
