import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Api, contentText, type Model, type ToolCall, type ToolResultMessage } from "theoses-ai";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { AgentSession } from "./agent-session.ts";
import { EpisodicStore } from "./episodic-store.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { EDGE_RELATIONS, FileMemoryStore } from "./memory-store.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { SessionManager, type SessionMessageEntry } from "./session-manager.ts";

/** Case-insensitive substring match anywhere in the user's message fires a consolidation pass. */
export const CONSOLIDATION_TRIGGER_PHRASES = [
	"thanks",
	"thank you",
	"great job",
	"good work",
	"nice work",
	"perfect",
	"awesome",
	"that's all",
	"all done",
];

/** Rare-case fallback for sessions that never say a completion phrase. */
export const CONSOLIDATION_TURN_CEILING = 70;

export function shouldTriggerConsolidation(userMessageText: string, turnsSinceCheckpoint: number): boolean {
	const lower = userMessageText.toLowerCase();
	if (CONSOLIDATION_TRIGGER_PHRASES.some((phrase) => lower.includes(phrase))) return true;
	return turnsSinceCheckpoint >= CONSOLIDATION_TURN_CEILING;
}

// ---------------------------------------------------------------------------
// Checkpoint state: "last successfully consolidated turn" per Channel Session.
// A lightweight JSON file rather than a new session-log record type — this is
// internal bookkeeping, not user-visible session history, so it doesn't need
// reducer-replay/branch-tree participation.
// ---------------------------------------------------------------------------

interface CheckpointFile {
	[channelSessionKey: string]: { lastEntryId: string | null };
}

function checkpointPath(): string {
	return (
		process.env.THEOSES_CONSOLIDATION_CHECKPOINTS ??
		join(homedir(), CONFIG_DIR_NAME, "consolidation-checkpoints.json")
	);
}

function channelSessionKey(channel: string, channelSessionId: string): string {
	return `${channel}:${channelSessionId}`;
}

function readCheckpoints(): CheckpointFile {
	const path = checkpointPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as CheckpointFile;
	} catch {
		return {};
	}
}

function writeCheckpoint(key: string, lastEntryId: string | null): void {
	const path = checkpointPath();
	mkdirSync(dirname(path), { recursive: true });
	const all = readCheckpoints();
	all[key] = { lastEntryId };
	writeFileSync(path, JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

const CONSOLIDATION_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

/**
 * Resolves the consolidation model from the live-hydrated OpenRouter catalog (rather than
 * hand-authoring cost/context-window numbers) and overlays the provider routing preference
 * (Baidu first — highest throughput of the chosen tier — then the cheaper but
 * lower-throughput OpenInference, DeepInfra, AkashML as fallbacks, fp8 quantization) plus caching:
 * `sendSessionAffinityHeaders`/`sessionAffinityFormat` are already auto-detected true for any
 * openrouter.ai baseUrl (see `packages/ai/src/api/openai-completions.ts`'s `isOpenRouter`
 * detection), so no extra wiring is needed there — a stable per-Channel-Session affinity id
 * (see `getConsolidationSession` below) is what makes that caching actually land across passes.
 */
export function resolveConsolidationModel(modelRuntime: ModelRuntime): Model<Api> {
	const model = modelRuntime.getModel("openrouter", CONSOLIDATION_MODEL_ID);
	if (!model) {
		throw new Error(
			`Consolidation model ${CONSOLIDATION_MODEL_ID} not found in the OpenRouter catalog. ` +
				"Ensure the model catalog is hydrated and OpenRouter is a configured provider.",
		);
	}
	return {
		...model,
		// Root cause of a real production failure: with no explicit per-request maxTokens, the
		// shared default (packages/ai's simple-options.ts) falls back to the model's full declared
		// max completion tokens (900K+ for this model) clamped to context. Cheap/shared-capacity-pool
		// providers reject that outright — confirmed via OpenRouter's own error metadata:
		// `provider_error_code: "queue_timeout"`, `limit_source: "upstream_provider_shared_pool"` —
		// committing to reserve output budget that large can't fit their queue. Consolidation only
		// emits a handful of structured tool calls; 32K is generous headroom, not a real constraint.
		maxTokens: 32000,
		compat: {
			...(model as Model<"openai-completions">).compat,
			openRouterRouting: {
				...(model as Model<"openai-completions">).compat?.openRouterRouting,
				// "Baidu Qianfan" is the pricing page's marketing label; the API's actual provider
				// slug is just "Baidu" — confirmed via /api/v1/models/.../endpoints, since "Baidu
				// Qianfan" silently matched zero endpoints and fell through the whole order list.
				order: ["Baidu", "OpenInference", "DeepInfra", "AkashML"],
				quantizations: ["fp8"],
				// Without this, `order` is only a preference — OpenRouter falls back to any other
				// provider (seen in practice: Nexbit, well outside the chosen cost/uptime tier) if
				// the ordered ones aren't suitable for a given request. Fail cost-strict instead.
				allow_fallbacks: false,
			},
		},
	} as Model<Api>;
}

// ---------------------------------------------------------------------------
// Custom tools bound to a specific run's stores, given to the consolidation model.
// ---------------------------------------------------------------------------

function buildConsolidationTools(memoryStore: FileMemoryStore, episodicStore: EpisodicStore): ToolDefinition[] {
	const emitFactSchema = Type.Object({
		subject: Type.String({ description: "A present, durable fact — one sentence." }),
		body: Type.Optional(Type.String({ description: "Optional 1-3 sentence elaboration." })),
	});
	const emitEdgeSchema = Type.Object({
		fromId: Type.String({ description: "The node id the edge originates from." }),
		targetId: Type.String({ description: "The node id the edge points to." }),
		rel: Type.Union(
			EDGE_RELATIONS.map((r) => Type.Literal(r)),
			{ description: `Relation type. One of: ${EDGE_RELATIONS.join(", ")}` },
		),
	});
	const emitEpisodeSchema = Type.Object({
		summary: Type.String({ description: "One-sentence summary of what happened in this window." }),
		startedAt: Type.String({ description: "ISO timestamp of the window's first turn." }),
		endedAt: Type.String({ description: "ISO timestamp of the window's last turn." }),
		relatedNodeIds: Type.Optional(Type.Array(Type.String())),
	});

	return [
		{
			name: "search_memory",
			label: "search_memory",
			description:
				"List existing memory node ids and subjects, for dedup/edge-authoring/supersession checks before emitting new facts.",
			promptSnippet: "List existing memory nodes",
			parameters: Type.Object({}),
			execute: async () => {
				const nodes = memoryStore.listNodes();
				const text = nodes.map((n) => `${n.id}: ${n.subject}`).join("\n") || "No existing memory nodes.";
				return { content: [{ type: "text", text }], details: undefined };
			},
		},
		{
			name: "emit_fact",
			label: "emit_fact",
			description:
				"Create a new semantic memory node for a durable fact surfaced in this window. No durability filter — capture anything that would matter to look up later, not just high-confidence signals. Returns the new node's id for use with emit_edge.",
			promptSnippet: "Record a durable fact",
			parameters: emitFactSchema,
			execute: async (_id, { subject, body }: Static<typeof emitFactSchema>) => {
				const node = memoryStore.createNode({ subject, body });
				return { content: [{ type: "text", text: node.id }], details: undefined };
			},
		},
		{
			name: "emit_edge",
			label: "emit_edge",
			description:
				"Link two memory nodes with a typed relation. Use rel: supersedes when a new fact updates or corrects an existing one — the old node is kept, not deleted.",
			promptSnippet: "Link two memory nodes",
			parameters: emitEdgeSchema,
			execute: async (_id, { fromId, targetId, rel }: Static<typeof emitEdgeSchema>) => {
				memoryStore.addEdge(fromId, { target: targetId, rel });
				return { content: [{ type: "text", text: "Edge recorded." }], details: undefined };
			},
		},
		{
			name: "emit_episode",
			label: "emit_episode",
			description: "Record what happened during this conversation window as an episodic memory entry.",
			promptSnippet: "Record an episode",
			parameters: emitEpisodeSchema,
			execute: async (_id, input: Static<typeof emitEpisodeSchema>) => {
				episodicStore.recordEpisode({
					startedAt: input.startedAt,
					endedAt: input.endedAt,
					summary: input.summary,
					relatedSemanticNodeIds: input.relatedNodeIds,
				});
				return { content: [{ type: "text", text: "Episode recorded." }], details: undefined };
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const CONSOLIDATION_INSTRUCTIONS = `You are Theoses's memory consolidation pass. You are given a window of a conversation
that just happened. Your job, in one pass:

1. Call search_memory to see what's already recorded.
2. For each durable fact in the window (preferences, facts about people/projects/systems, standing
   decisions — no durability filter, capture generously), call emit_fact. If a fact already exists
   (same meaning, different wording), do not re-emit it — skip it. If a new fact contradicts an
   existing one, emit_fact for the new one, then emit_edge with rel: supersedes from the new node
   to the old node.
3. For facts that relate to each other or to existing nodes, call emit_edge with an appropriate
   relation type.
4. Call emit_episode exactly once, summarizing what happened in this window as a whole (not
   individual facts), with startedAt/endedAt spanning the window's timestamps.

Respond with a brief plain-text confirmation once done. Do not ask questions — this is a
non-interactive background pass.`;

interface ConsolidationSession {
	agentSession: AgentSession;
}

/** Filename-safe deterministic id, stable per Channel Session, for OpenRouter cache-affinity only. */
function consolidationSessionAffinityId(channel: string, channelSessionId: string): string {
	return `consolidation-${channel}-${channelSessionId}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Always creates a fresh, one-shot session — never reuses/appends to a prior consolidation pass's
 * conversation. Real production incident: caching and reusing the same AgentSession across passes
 * (the original design here) meant every retry re-sent the full accumulated history on top of the
 * last, compounding a single pass past 1M input tokens across a handful of retries. Continuity
 * across passes comes from `search_memory` against the persisted store, not raw conversation
 * history — so a stateless session loses nothing real. The session-affinity id is still deterministic
 * per Channel Session (not the fresh session's own random id) so OpenRouter's prompt-caching still
 * gets a stable key to pin to, independent of this being a new session object each call.
 */
async function getConsolidationSession(
	cwd: string,
	channel: string,
	channelSessionId: string,
	model: Model<Api>,
	modelRuntime: ModelRuntime,
	memoryStore: FileMemoryStore,
	episodicStore: EpisodicStore,
): Promise<ConsolidationSession> {
	const key = channelSessionKey(channel, channelSessionId);
	const sessionManager = SessionManager.create(cwd, undefined, {
		channel: "consolidation",
		channelSessionId: key,
		id: consolidationSessionAffinityId(channel, channelSessionId),
	});
	const { session } = await import("./sdk.ts").then((sdk) =>
		sdk.createAgentSession({
			cwd,
			sessionManager,
			modelRuntime,
			model,
			// Restrict to exactly the 4 custom tools this pass uses — `tools` is an allowlist
			// that applies to customTools too (an empty array would silently disable them, not
			// just the built-ins). search_memory replaces the need for read/grep/find/ls against
			// the memory store, and every extra tool schema grows the request size — which is
			// exactly what tipped a real run into a 429 on OpenInference's low-throughput tier.
			tools: ["search_memory", "emit_fact", "emit_edge", "emit_episode"],
			customTools: buildConsolidationTools(memoryStore, episodicStore),
		}),
	);
	return { agentSession: session };
}

export interface MaybeRunConsolidationOptions {
	cwd: string;
	channel: string;
	channelSessionId: string;
	/** The just-completed turn's user message text, checked against the trigger phrases. */
	userMessageText: string;
	mainSessionManager: SessionManager;
	modelRuntime: ModelRuntime;
	memoryStore?: FileMemoryStore;
	episodicStore?: EpisodicStore;
}

/**
 * Fire-and-forget entry point: checks the trigger, and if it fires, runs consolidation over
 * every turn since the last successful checkpoint. Never throws — callers should not await this
 * in the response path; call it and let it run in the background (`.catch` is handled internally).
 */
export function maybeRunConsolidation(options: MaybeRunConsolidationOptions): void {
	void runIfTriggered(options).catch((error) => {
		console.error(
			`Memory consolidation failed for ${options.channel}:${options.channelSessionId}:`,
			error instanceof Error ? error.message : error,
		);
	});
}

/** Tool-result bodies (file contents, command output, API responses) can be arbitrarily large;
 * consolidation only needs enough to know what the outcome was, not the full payload. */
const MAX_TOOL_RESULT_CHARS = 500;
/** Tool-call arguments (a whole file write, a long bash command) are rarely a durable fact by
 * themselves — keep just enough to identify what was attempted. */
const MAX_TOOL_ARGS_CHARS = 200;

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function summarizeToolCall(call: ToolCall): string {
	return `called ${call.name}(${truncate(JSON.stringify(call.arguments ?? {}), MAX_TOOL_ARGS_CHARS)})`;
}

function summarizeToolResult(message: ToolResultMessage): string {
	return `${message.isError ? "FAILED" : "OK"} — ${truncate(contentText(message.content), MAX_TOOL_RESULT_CHARS)}`;
}

/**
 * Builds the consolidation transcript from a window of session messages. Keeps user and assistant
 * text in full (that's where durable facts and outcomes live) but condenses tool calls down to
 * "which tool, brief args", tool results down to "succeeded/failed, brief result", and bash
 * executions down to the command plus a brief snippet of output — the full raw tool-call arguments
 * and tool-result payloads (bash output, file contents, API responses) were previously included
 * verbatim, which is what pushed a single consolidation pass's transcript into the hundreds of
 * thousands of tokens for tool-heavy windows.
 */
function entriesToTranscript(entries: SessionMessageEntry[]): string {
	return entries
		.map((entry) => {
			const message = entry.message;
			let text: string;
			switch (message.role) {
				case "user":
					text = contentText(message.content);
					break;
				case "assistant":
					text = message.content
						.map((block) => {
							if (block.type === "text") return block.text;
							if (block.type === "toolCall") return summarizeToolCall(block);
							return undefined; // drop thinking blocks — internal reasoning, not a durable fact source
						})
						.filter((value): value is string => Boolean(value))
						.join("\n");
					break;
				case "toolResult":
					text = summarizeToolResult(message);
					break;
				case "bashExecution":
					text = `ran \`${truncate(message.command, MAX_TOOL_ARGS_CHARS)}\` — ${
						message.cancelled
							? "cancelled"
							: `exit ${message.exitCode ?? "?"}: ${truncate(message.output, MAX_TOOL_RESULT_CHARS)}`
					}`;
					break;
				case "branchSummary":
				case "compactionSummary":
					text = message.summary;
					break;
				case "custom":
					text = contentText(message.content);
					break;
				default:
					text = "";
			}
			return `[${entry.timestamp}] ${message.role}: ${text}`;
		})
		.join("\n");
}

/**
 * Runs one consolidation pass over an already-extracted window of message entries. Shared by both
 * the live trigger path and backfill — the extraction prompt and tool set are identical either way,
 * only how the window and target session are chosen differs.
 */
async function runConsolidationPass(params: {
	cwd: string;
	channel: string;
	channelSessionId: string;
	window: SessionMessageEntry[];
	modelRuntime: ModelRuntime;
	memoryStore: FileMemoryStore;
	episodicStore: EpisodicStore;
}): Promise<void> {
	const { cwd, channel, channelSessionId, window, modelRuntime, memoryStore, episodicStore } = params;
	if (window.length === 0) return;

	const transcript = entriesToTranscript(window);
	const model = resolveConsolidationModel(modelRuntime);
	const { agentSession } = await getConsolidationSession(
		cwd,
		channel,
		channelSessionId,
		model,
		modelRuntime,
		memoryStore,
		episodicStore,
	);

	// A turn that ends without ever calling emit_episode (per CONSOLIDATION_INSTRUCTIONS, it must
	// fire exactly once) or that hits a hard provider failure produces no error by itself — the
	// agent loop settles normally either way. Watch for both explicitly so a silently-empty pass
	// (seen in practice: 429s exhausting retries, `agent_settled` firing with nothing written)
	// throws instead of being reported as done, which would wrongly advance the checkpoint.
	let episodeEmitted = false;
	let retryFailure: string | undefined;
	let messageError: string | undefined;
	const unsubscribe = agentSession.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "emit_episode") episodeEmitted = true;
		if (event.type === "auto_retry_end" && !event.success) retryFailure = event.finalError;
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
			messageError = event.message.errorMessage ?? "unknown error";
		}
		if (process.env.THEOSES_DEBUG_CONSOLIDATION) {
			console.error("CONSOLIDATION_EVENT", event.type, JSON.stringify(event).slice(0, 500));
		}
	});
	try {
		await agentSession.prompt(`${CONSOLIDATION_INSTRUCTIONS}\n\n--- Conversation window ---\n${transcript}`);
		await agentSession.agent.waitForIdle();
	} finally {
		unsubscribe();
	}

	if (retryFailure) throw new Error(`Consolidation pass failed after retries: ${retryFailure}`);
	if (messageError) throw new Error(`Consolidation pass errored: ${messageError}`);
	if (!episodeEmitted) throw new Error("Consolidation pass ended without calling emit_episode");
}

async function runIfTriggered(options: MaybeRunConsolidationOptions): Promise<void> {
	const { cwd, channel, channelSessionId, userMessageText, mainSessionManager, modelRuntime } = options;
	const memoryStore = options.memoryStore ?? new FileMemoryStore();
	const episodicStore = options.episodicStore ?? (await EpisodicStore.create());

	const key = channelSessionKey(channel, channelSessionId);
	const checkpoints = readCheckpoints();
	const lastEntryId = checkpoints[key]?.lastEntryId ?? null;

	const branch = mainSessionManager.getBranch();
	const startIndex = lastEntryId ? branch.findIndex((e) => e.id === lastEntryId) + 1 : 0;
	const window = branch.slice(startIndex).filter((e): e is SessionMessageEntry => e.type === "message");
	if (window.length === 0) return;

	if (!shouldTriggerConsolidation(userMessageText, window.length)) return;

	await runConsolidationPass({ cwd, channel, channelSessionId, window, modelRuntime, memoryStore, episodicStore });

	// Only advance the checkpoint on success — a failure above throws before this line, so the
	// window rolls into the next trigger instead of being silently dropped.
	const lastWindowEntry = window[window.length - 1];
	if (lastWindowEntry) writeCheckpoint(key, lastWindowEntry.id);
}

// ---------------------------------------------------------------------------
// Backfill: run the same extraction pipeline against historical session-log files.
// Reusable for any future gap in memory-service uptime, not just the initial run.
// ---------------------------------------------------------------------------

export interface BackfillOptions {
	cwd: string;
	modelRuntime: ModelRuntime;
	memoryStore?: FileMemoryStore;
	episodicStore?: EpisodicStore;
}

/**
 * Runs consolidation over an entire historical session-log file, sub-chunked into windows of at
 * most CONSOLIDATION_TURN_CEILING messages — the same bound the live trigger enforces, so a
 * backfilled file never produces a single pass larger than live consolidation ever would. Chunks
 * run sequentially, not in parallel: each chunk's search_memory call needs to see facts the prior
 * chunk already wrote, for dedup/supersession continuity within one file. Each chunk is still its
 * own fresh, stateless session (getConsolidationSession creates a new one every call) — chunking
 * bounds a single pass's size, it doesn't reintroduce cross-call accumulation.
 * Does not touch the live checkpoint file — backfill is a separate, explicit operation.
 */
export async function backfillFromSessionLog(path: string, options: BackfillOptions): Promise<void> {
	const sessionManager = SessionManager.open(path);
	const header = sessionManager.getChannelSessionKey();
	const branch = sessionManager.getBranch();
	const window = branch.filter((e): e is SessionMessageEntry => e.type === "message");
	if (window.length === 0) return;

	const memoryStore = options.memoryStore ?? new FileMemoryStore();
	const episodicStore = options.episodicStore ?? (await EpisodicStore.create());

	for (let start = 0; start < window.length; start += CONSOLIDATION_TURN_CEILING) {
		const chunk = window.slice(start, start + CONSOLIDATION_TURN_CEILING);
		await runConsolidationPass({
			cwd: options.cwd,
			channel: header.channel,
			channelSessionId: header.channelSessionId,
			window: chunk,
			modelRuntime: options.modelRuntime,
			memoryStore,
			episodicStore,
		});
	}
}
