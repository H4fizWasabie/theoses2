/**
 * Background explorer sub-agent (issue #254).
 *
 * Codebase scouting (grep/read dumps) lands on the main agent's context and stays there for
 * turns — driving up cost and context pollution, since explore output is used briefly but paid
 * for on every subsequent turn. This module spawns a cheap, isolated agent (DeepSeek flash tier
 * via OpenRouter) with a strictly read-only toolset (read/grep/find/ls) whose entire job is to
 * answer ONE scouting question and return a *distilled* answer capped by the tier's line/token
 * budget — never raw tool dumps.
 *
 * Two tiers (agreed 2026-09-14, in #254):
 * - quick-scan (default): "which file handles X" — answer ≤30 lines / ~800 tokens.
 * - deep-map: "map this subsystem" — answer ≤80 lines / ~2K tokens, plus a structural overview.
 *
 * Enforcement is harness-side, not prompt-trust: the returned answer is line-capped and a
 * budget footer is appended if the explorer didn't emit one. Concurrency is capped at
 * MAX_CONCURRENT_EXPLORERS via a semaphore; the main thread may issue up to that many in
 * parallel for independent questions (spawn #3 waits for a slot instead of a 4th running).
 */

import { Agent, type AgentEvent, type AgentMessage } from "theoses-agent-core";
import type { Api, Model } from "theoses-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { createFindToolDefinition } from "./tools/find.ts";
import { createGrepToolDefinition } from "./tools/grep.ts";
import { createLsToolDefinition } from "./tools/ls.ts";
import { createReadToolDefinition } from "./tools/read.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";

const EXPLORER_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

export const MAX_CONCURRENT_EXPLORERS = 3;

const TIER_CAPS = {
	"quick-scan": { lines: 30, approxTokens: 800, maxTurns: 8, maxInputTokens: 200_000 },
	"deep-map": { lines: 80, approxTokens: 2000, maxTurns: 15, maxInputTokens: 400_000 },
} as const;

export type ExplorerTier = keyof typeof TIER_CAPS;

export interface ExplorerResult {
	/** The distilled answer (capped, footer ensured). Never raw tool dumps. */
	answer: string;
	/** false when the budget ran out and the answer is partial — see the INCOMPLETE contract. */
	complete: boolean;
	tier: ExplorerTier;
	turnsUsed: number;
	maxTurns: number;
	inputTokens: number;
	outputTokens: number;
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

class Semaphore {
	private waiters: (() => void)[] = [];
	private available: number;

	constructor(limit: number) {
		this.available = limit;
	}

	async acquire(): Promise<() => void> {
		if (this.available > 0) {
			this.available--;
			return () => this.release();
		}
		return new Promise((resolve) => {
			this.waiters.push(() => {
				this.available--;
				resolve(() => this.release());
			});
		});
	}

	private release(): void {
		this.available++;
		const next = this.waiters.shift();
		if (next) next();
	}
}

const explorerSlots = new Semaphore(MAX_CONCURRENT_EXPLORERS);

/** Test-only: reset the global slot semaphore (module state otherwise survives across tests). */
export function resetExplorerConcurrencyForTests(): void {
	(explorerSlots as unknown as { available: number }).available = MAX_CONCURRENT_EXPLORERS;
	(explorerSlots as unknown as { waiters: (() => void)[] }).waiters = [];
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the explorer model from the live-hydrated OpenRouter catalog. Same model id and
 * fp8/fail-strict shape as memory consolidation (see memory-consolidation.ts), but a *different*
 * provider chain: #254 pins OpenInference first specifically for its per-provider KV-cache hit
 * rate, then Baseten (US) and GMI Cloud as fallbacks — do not copy consolidation's Baidu-first
 * order here, the two were decided independently.
 *
 * Provider slugs verified against the live OpenRouter endpoints listing (same method as the
 * "Baidu"/"AkashML" slug lessons from issues #180/#190: marketing labels on the pricing page
 * don't always match the API's `provider_name`): "OpenInference", "BaseTen", "GMICloud" (no
 * space). Note the endpoints listing exposes two identical "BaseTen" entries with no
 * region-distinguishing field, so a "US"-specific slug can't be confirmed from the public API —
 * pinning plain "BaseTen" covers both until OpenRouter exposes a region tag to disambiguate.
 *
 * Kept as a separate resolver rather than reusing `resolveConsolidationModel` so consolidation's
 * maxTokens/output-shape tuning (single JSON object) stays independent from the explorer's
 * agentic multi-turn shape.
 */
export function resolveExplorerModel(modelRuntime: ModelRuntime): Model<Api> {
	const model = modelRuntime.getModel("openrouter", EXPLORER_MODEL_ID);
	if (!model) {
		throw new Error(
			`Explorer model ${EXPLORER_MODEL_ID} not found in the OpenRouter catalog. ` +
				"Ensure the model catalog is hydrated and OpenRouter is a configured provider.",
		);
	}
	return {
		...model,
		// Same shared-capacity-pool failure shape as consolidation (see its comment): a huge
		// default maxTokens makes fp8 pool providers reject with queue_timeout. The explorer
		// returns ≤2K-token answers but may draft internally; 8K is headroom, not a real cap.
		maxTokens: 8000,
		compat: {
			...(model as Model<"openai-completions">).compat,
			openRouterRouting: {
				...(model as Model<"openai-completions">).compat?.openRouterRouting,
				order: ["OpenInference", "BaseTen", "GMICloud"],
				quantizations: ["fp8"],
				allow_fallbacks: false,
			},
		},
	} as Model<Api>;
}

// ---------------------------------------------------------------------------
// System prompt — the output contract
// ---------------------------------------------------------------------------

function buildExplorerSystemPrompt(tier: ExplorerTier): string {
	const caps = TIER_CAPS[tier];
	const structural =
		tier === "deep-map"
			? "\n4. Start with a 5–15 line structural overview: components, entry points, data flow. Then the findings.\n"
			: "";
	return `You are Theoses's background explorer: a cheap, isolated scouting agent. You answer ONE question about a codebase by reading it yourself, then return a DISTILLED answer. You never return raw tool dumps.

Hard output cap: at most ${caps.lines} lines and ~${caps.approxTokens} tokens of answer. This is enforced by the harness — an oversized answer is truncated, losing your last lines.

Rules:
1. Pointers, not pastes: reference \`file:line\` locations instead of quoting code. You may read 200-line files internally; the answer carries findings + paths only.
2. Answer format: 1–3 sentence direct answer first, then at most 5 short secondary bullets (caveats, related spots).${structural}
3. End with one budget footer line: \`~<K> in, <turns>/${caps.maxTurns} turns\` (input tokens spent so far, turns used).
5. You have at most ${caps.maxTurns} turns and ~${caps.maxInputTokens / 1000}K input tokens. Stop early rather than pad: if you hit the budget before answering fully, output exactly \`INCOMPLETE: <one line on what is missing>\` plus the footer — nothing else.
5. Read-only: read, grep, find, ls only. You cannot edit files or run commands.
6. Answer from evidence you gathered. If you could not find the answer, say so explicitly instead of guessing specifics.`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function lineCount(text: string): number {
	return text.split("\n").length;
}

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

function enforceAnswerCap(answer: string, tier: ExplorerTier): string {
	const caps = TIER_CAPS[tier];
	if (lineCount(answer) <= caps.lines) return answer;
	const truncated = answer.split("\n").slice(0, caps.lines).join("\n");
	return `${truncated}\n[truncated by harness: exceeded ${tier} cap of ${caps.lines} lines]`;
}

function ensureBudgetFooter(answer: string, tier: ExplorerTier, turns: number, inputTokens: number): string {
	// The explorer was told to emit its own footer; append the authoritative one only when it forgot.
	// Footer shape is `~<K> in, <turns>/<max> turns` (no brackets) — match that, not a literal "turns]".
	if (/~\d+K in, \d+\/\d+ turns\s*$/.test(answer.trimEnd())) return answer;
	const kIn = Math.round(inputTokens / 1000);
	return `${answer}\n~${kIn}K in, ${turns}/${TIER_CAPS[tier].maxTurns} turns`;
}

export interface RunExplorerOptions {
	question: string;
	tier?: ExplorerTier;
	cwd: string;
	modelRuntime: ModelRuntime;
	signal?: AbortSignal;
	/** Streaming status text (current activity), surfaced by the explore tool's onUpdate. */
	onStatus?: (status: string) => void;
}

export async function runExplorer(options: RunExplorerOptions): Promise<ExplorerResult> {
	const tier = (options.tier ?? "quick-scan") as ExplorerTier;
	const caps = TIER_CAPS[tier];
	const model = resolveExplorerModel(options.modelRuntime);

	const release = await explorerSlots.acquire();
	try {
		return await runExplorerWithSlot(options, tier, caps, model);
	} finally {
		release();
	}
}

async function runExplorerWithSlot(
	options: RunExplorerOptions,
	tier: ExplorerTier,
	caps: (typeof TIER_CAPS)[ExplorerTier],
	model: Model<Api>,
): Promise<ExplorerResult> {
	const readOnlyToolDefinitions = [
		createReadToolDefinition(options.cwd),
		createGrepToolDefinition(options.cwd),
		createFindToolDefinition(options.cwd),
		createLsToolDefinition(options.cwd),
	];

	let turns = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let stoppedByBudget = false;

	const agent: Agent = new Agent({
		initialState: {
			systemPrompt: buildExplorerSystemPrompt(tier),
			model,
			thinkingLevel: "off",
			tools: readOnlyToolDefinitions.map((definition) => wrapToolDefinition(definition)),
		},
		streamFn: (streamModel, context, streamOptions) =>
			options.modelRuntime.streamSimple(streamModel, context, streamOptions),
		shouldStopAfterTurn: () => {
			turns++;
			if (turns >= caps.maxTurns || inputTokens >= caps.maxInputTokens) {
				stoppedByBudget = true;
				return true;
			}
			return false;
		},
	});

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			options.onStatus?.(`${event.toolName}: ${summarizeArgs(event.args)}`);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
			if (usage) {
				inputTokens += usage.input ?? 0;
				outputTokens += usage.output ?? 0;
			}
		}
	});

	if (options.signal) {
		const abortListener = () => agent.abort();
		options.signal.addEventListener("abort", abortListener, { once: true });
	}

	try {
		await agent.prompt(options.question);
	} finally {
		unsubscribe();
	}

	// Did the run end with a complete answer, or did the budget cut it off mid-work? If the
	// budget stopped us (or the last assistant turn was a tool call we never got an answer
	// after), the outcome is INCOMPLETE — the one-line contract, not a padded guess.
	const rawAnswer = lastAssistantText(agent.state.messages);
	const pendingToolCall = endedOnToolCall(agent.state.messages);
	const complete =
		!stoppedByBudget && !pendingToolCall && rawAnswer.length > 0 && !rawAnswer.startsWith("INCOMPLETE:");

	let answer = complete ? rawAnswer : `INCOMPLETE: budget exhausted before a final answer was produced.`;
	if (complete) {
		answer = enforceAnswerCap(answer, tier);
		answer = ensureBudgetFooter(answer, tier, turns, inputTokens);
	} else {
		const kIn = Math.round(inputTokens / 1000);
		answer += `\n~${kIn}K in, ${turns}/${caps.maxTurns} turns`;
	}

	return { answer, complete, tier, turnsUsed: turns, maxTurns: caps.maxTurns, inputTokens, outputTokens };
}

function summarizeArgs(args: unknown): string {
	try {
		const record = args as Record<string, unknown>;
		return JSON.stringify(record).slice(0, 120);
	} catch {
		return "";
	}
}

function endedOnToolCall(messages: AgentMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall");
}

// ---------------------------------------------------------------------------
// Tool exposure
// ---------------------------------------------------------------------------

const exploreSchema = Type.Object({
	question: Type.String({ description: "The single scouting question to answer" }),
	tier: Type.Optional(
		Type.Union([Type.Literal("quick-scan"), Type.Literal("deep-map")], {
			description:
				"quick-scan (default): single-fact lookups, ≤30-line answer. deep-map: subsystem walkthroughs, ≤80-line answer.",
		}),
	),
});
type ExploreInput = Static<typeof exploreSchema>;

export interface ExploreToolDeps {
	modelRuntime: ModelRuntime;
	cwd: string;
}

export function createExploreToolDefinition(deps: ExploreToolDeps): ToolDefinition<typeof exploreSchema> {
	return {
		name: "explore",
		label: "explore",
		description:
			"Spawn a background explorer sub-agent (read-only, cheap DeepSeek model) to scout a codebase question and return a distilled, line-capped answer instead of raw grep/read dumps. Use for codebase scouting questions ('which file handles X', 'map this subsystem'); it keeps its tool dumps out of your context. Up to 3 explorers run concurrently, so you may call explore several times in parallel for independent questions.",
		promptSnippet:
			"Scout a codebase question with an isolated read-only sub-agent; returns a distilled, capped answer",
		promptGuidelines: [
			"Route codebase scouting (find the file that handles X, map subsystem Y) to `explore` instead of doing raw grep/read sweeps yourself — the explorer's tool dumps never enter your context, only its capped answer does.",
			"`explore` answers one question per call. Call it multiple times in one turn for independent questions (up to 3 run concurrently).",
		],
		parameters: exploreSchema,
		// Explore runs a full sub-agent loop; it can't execute in parallel with sibling tool
		// calls safely by default — the semaphore handles its own concurrency budget.
		execute: async (_toolCallId, { question, tier }: ExploreInput, signal, onUpdate) => {
			const result = await runExplorer({
				question,
				tier,
				cwd: deps.cwd,
				modelRuntime: deps.modelRuntime,
				signal,
				onStatus: (status) => onUpdate?.({ content: [{ type: "text", text: status }], details: undefined }),
			});
			const header = result.complete ? "" : "INCOMPLETE (explorer hit its budget) — consider a narrower re-spawn.\n";
			return {
				content: [{ type: "text", text: `${header}${result.answer}` }],
				details: result,
			};
		},
	};
}
