/**
 * Background deep-research sub-agent.
 *
 * Sibling of explorer.ts, but for the web instead of the codebase, and asynchronous: the `research`
 * tool starts a job and returns at once; when the job finishes its report is delivered back into the
 * session as a follow-up custom message that triggers a turn if the agent is idle. The agent loop
 * uses the same OpenRouter background-model slot machinery as the explorer (`backgroundModels.research`),
 * with Tavily search and extract as its only tools.
 *
 * The agent decides when to call it, so safety is harness-side caps: per-job turns, input tokens,
 * Tavily calls and wall-clock time, plus per-session concurrency and job-count limits. Jobs live in
 * process memory only; a restart loses in-flight ones.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "theoses-agent-core";
import type { Api, Model, ModelsRequestTransforms, ProviderHeaders, SimpleStreamOptions } from "theoses-ai";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import { type ResolvedBackgroundModelSetting, resolveBackgroundModelSetting } from "./background-models.ts";
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

/** Chars of the report delivered into context; the full report is always written to a file. */
const DELIVERED_REPORT_CHARS = 6000;

/** Same model and fp8/fail-strict routing as the explorer until real reports show it is too weak. */
const RESEARCH_DEFAULTS: ResolvedBackgroundModelSetting = {
	model: "deepseek/deepseek-v4-flash-0731",
	providers: ["Baidu", "DeepInfra"],
	quantizations: ["fp8"],
};

export function resolveResearchModel(modelRuntime: ModelRuntime): Model<Api> {
	const setting = resolveBackgroundModelSetting(
		"research",
		RESEARCH_DEFAULTS,
		modelRuntime.getBackgroundModelSetting?.("research"),
	);
	const model = modelRuntime.getModel("openrouter", setting.model);
	if (!model) {
		throw new Error(
			`Research model ${setting.model} not found in the OpenRouter catalog. ` +
				"Ensure the model catalog is hydrated and OpenRouter is a configured provider.",
		);
	}
	return {
		...model,
		// Reports run longer than explorer answers, but a huge maxTokens still makes fp8 pool providers
		// reject with queue_timeout (see the explorer's resolver).
		maxTokens: 16000,
		compat: {
			...(model as Model<"openai-completions">).compat,
			openRouterRouting: {
				...(model as Model<"openai-completions">).compat?.openRouterRouting,
				order: setting.providers,
				...(setting.quantizations.length > 0 ? { quantizations: setting.quantizations } : {}),
				allow_fallbacks: false,
			},
		},
	} as Model<Api>;
}

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
	const model = resolveResearchModel(options.modelRuntime);
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
	} finally {
		unsubscribe();
	}

	const text = lastAssistantText(agent.state.messages);
	const complete = !stoppedByBudget && !signal.aborted && !endedOnToolCall(agent.state.messages) && text.length > 0;
	const report = complete
		? text
		: `INCOMPLETE: the job hit its budget or timeout before finishing.${text ? `\n\nLast notes:\n${text}` : ""}`;
	return { report, complete, turnsUsed: turns, inputTokens };
}

/** Per-session job accounting. One instance lives on the AgentSession so runtime rebuilds don't reset it. */
export class ResearchJobs {
	running = 0;
	started = 0;
	private controller = new AbortController();

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	abortAll(): void {
		this.controller.abort();
	}
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
	/** Delivers the finished report into the session as a follow-up that triggers a turn. */
	deliver: (text: string) => Promise<void>;
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
			"Start a background deep-research job on the web (searches and reads many sources, cross-checks them, writes a cited report). Returns immediately; the report arrives later as a follow-up message, so keep helping the user meanwhile. Use for open-ended, multi-source questions (comparisons, current state of a topic, market or technical surveys). Do NOT use for a single fact (use web_search) or for questions about the codebase (use explore). Each job costs real money and takes several minutes.",
		promptSnippet: "Start an asynchronous multi-source web research job; the cited report arrives later",
		promptGuidelines: [
			"Use `research` only when the question needs many sources or cross-checking. Single facts belong to `web_search`, code questions to `explore`.",
			"`research` returns at once and delivers the report later as a message. Tell the user it is running and carry on; never poll or start a duplicate job.",
		],
		parameters: researchSchema,
		execute: async (_toolCallId, { question }: ResearchInput) => {
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
			void runResearch({ ...deps, question, signal: jobs.signal })
				.then((result) => {
					const path = saveReport(id, question, result.report);
					const body = result.report.slice(0, DELIVERED_REPORT_CHARS);
					const cut =
						result.report.length > body.length ? `\n[truncated, full report: ${path}]` : `\n[saved: ${path}]`;
					return `Research job ${id} finished (${result.turnsUsed} turns, ${Math.round(result.inputTokens / 1000)}K in). Question: ${question}\n\n${body}${cut}`;
				})
				.catch((error) => `Research job ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
				.then(async (text) => {
					if (!jobs.signal.aborted) await deps.deliver(text);
				})
				.catch(() => {})
				.finally(() => {
					jobs.running--;
				});
			return reply(
				`Research job ${id} started. The report arrives later as a follow-up message (typically a few minutes); it may be lost if the service restarts.`,
			);
		},
	};
}
