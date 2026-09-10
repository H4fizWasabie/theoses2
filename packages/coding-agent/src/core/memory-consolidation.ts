import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	contentText,
	type Model,
	retryAssistantCall,
	type ToolCall,
	type ToolResultMessage,
} from "theoses-ai";
import type { Context, SimpleStreamOptions } from "theoses-ai/compat";
import { getAgentDir } from "../config.ts";
import { EpisodicStore } from "./episodic-store.ts";
import { EDGE_RELATIONS, type EdgeRelation, FileMemoryStore } from "./memory-store.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { SessionManager, type SessionMessageEntry } from "./session-manager.ts";

/**
 * Issue #180: single-attempt, single-turn retry policy for the one structured-output call a
 * consolidation pass now makes. Mirrors SettingsManager.getRetrySettings()'s defaults (enabled,
 * 3 retries, 2s base delay) — this module runs headless in the background and has no
 * SettingsManager instance of its own to read those from.
 */
const CONSOLIDATION_RETRY_POLICY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

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
	[channelSessionKey: string]: { lastEntryId: string | null; lastFailureAt?: string };
}

/**
 * Issue #177: without a cooldown, a failing checkpoint never advances (by design — see
 * writeCheckpoint's comment), which meant `turnsSinceCheckpoint` stayed >= CONSOLIDATION_TURN_CEILING
 * forever and every single subsequent turn re-triggered consolidation again, each time reprocessing
 * a larger accumulated window. Confirmed in production: this compounded into 500K+ token consolidation
 * calls firing every 1-3 minutes, hammering the same process the live chat runs on. A failure now
 * blocks re-triggering for this window instead of retrying on every turn.
 */
const CONSOLIDATION_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

function checkpointPath(): string {
	// Derived from getAgentDir() (respects THEOSES_CODING_AGENT_DIR) rather than a bare homedir()
	// call — see episodic-store.ts's defaultEpisodicDbPath() and memory-store.ts's
	// getMemoriesDir() for the same fix applied to the other stores in this package.
	return (
		process.env.THEOSES_CONSOLIDATION_CHECKPOINTS ?? join(dirname(getAgentDir()), "consolidation-checkpoints.json")
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

/** Clears any prior failure marker for this key — a successful pass means the cooldown no longer applies. */
function writeCheckpoint(key: string, lastEntryId: string | null): void {
	const path = checkpointPath();
	mkdirSync(dirname(path), { recursive: true });
	const all = readCheckpoints();
	all[key] = { lastEntryId };
	writeFileSync(path, JSON.stringify(all, null, 2));
}

/** Records a failure without touching lastEntryId, so the next trigger still resumes from the same window once the cooldown passes. */
function writeFailure(key: string, at: string): void {
	const path = checkpointPath();
	mkdirSync(dirname(path), { recursive: true });
	const all = readCheckpoints();
	all[key] = { lastEntryId: all[key]?.lastEntryId ?? null, lastFailureAt: at };
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
 * (see `consolidationSessionAffinityId` below) is what makes that caching actually land across passes.
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
		// emits one JSON object (facts + edges + episode) per chunk; 32K is generous headroom, not a
		// real constraint.
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
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Issue #180: a single structured-output call per chunk, not a multi-turn agentic tool loop.
 * The prior design had the model call search_memory once, then one emit_fact/emit_edge per
 * durable fact found, then emit_episode — every one of those turns being a fresh LLM call that
 * resent the entire accumulated conversation so far in the pass. A window with 18 facts cost on
 * the order of 18 sequential re-sends of an ever-growing prompt. A keyword-narrowed slice of
 * existing node subjects is embedded directly in the prompt (`buildExistingNodesSection` below)
 * instead of a live search_memory call, since dedup checking doesn't need a tool round-trip when
 * the candidate nodes are cheap to include once. Local ids (f1, f2, ...) let the model wire up
 * edges and the episode's related facts within its own single response, before any real node id
 * exists.
 */
const CONSOLIDATION_INSTRUCTIONS = `You are Theoses's memory consolidation pass. You are given a window of a
conversation that just happened, and a list of memory nodes that already exist. Extract durable facts,
relations between them, and a summary of what happened — all as a single JSON object. Do not call any tools.

Return ONLY a JSON object with this exact shape, no markdown fences, no commentary:
{
  "facts": [{"id": "f1", "subject": "one durable fact, one sentence", "body": "optional 1-3 sentence elaboration"}],
  "edges": [{"from": "f1 or an existing node id", "to": "f2 or an existing node id", "rel": "one of: ${EDGE_RELATIONS.join(", ")}"}],
  "episode": {"summary": "one-sentence summary of what happened in this window as a whole", "startedAt": "ISO timestamp of the window's first turn", "endedAt": "ISO timestamp of the window's last turn", "relatedFactIds": ["f1"]}
}

Rules:
- facts: preferences, facts about people/projects/systems, standing decisions — no durability filter,
  capture generously. "id" is a short local id (f1, f2, ...) used only to wire up edges/relatedFactIds
  within this response; it is not the real, persisted node id. If a fact in the window already exists in
  "Existing memory nodes" below (same meaning, different wording), do not re-emit it — skip it. If a new
  fact contradicts an existing one, still emit the new fact and add an edge with rel: supersedes from the
  new fact's local id to the existing node's real id.
- edges: link facts that relate to each other or to an existing node. "from"/"to" may be a local fact id
  (f1) or a real existing node id copied from the list below.
- episode: required, exactly one, summarizing the window as a whole (not individual facts). relatedFactIds
  may reference local fact ids and/or real existing node ids.`;

/**
 * Existing memory nodes to embed in the prompt for dedup/edge-authoring/supersession checks —
 * keyword-narrowed against the window's own text, not a dump of the whole store. Mirrors
 * mino-oss's graphCandidates/keywordCandidates (memory.go): mino caps its own candidate list to
 * the top 8 matches for the same reason — a full dump would make a single pass's prompt size
 * scale with total memory-store size instead of the window's size, which is exactly the growth
 * issue #180 is about. Reuses `remember()` (the live-recall path) rather than a bespoke scorer,
 * since it already does keyword-entry + edge-walk scoring over the same node set.
 */
function buildExistingNodesSection(memoryStore: FileMemoryStore, transcript: string): string {
	const candidates = memoryStore.remember(transcript);
	return candidates.map((c) => `${c.id}: ${c.text}`).join("\n") || "No existing memory nodes.";
}

interface ParsedFact {
	id: string;
	subject: string;
	body?: string;
}

interface ParsedEdge {
	from: string;
	to: string;
	rel: EdgeRelation;
}

interface ParsedEpisode {
	summary: string;
	startedAt: string;
	endedAt: string;
	relatedFactIds?: string[];
}

interface ParsedConsolidation {
	facts: ParsedFact[];
	edges: ParsedEdge[];
	episode: ParsedEpisode;
}

function isEdgeRelation(value: unknown): value is EdgeRelation {
	return typeof value === "string" && (EDGE_RELATIONS as readonly string[]).includes(value);
}

/**
 * Tolerant JSON parsing for the model's structured-output response — same precedent as
 * compaction.ts's DISTILLATION_PROMPT/distillMemory path for the same model family: strip
 * markdown code fences if present, then validate shape field-by-field rather than trusting the
 * whole payload, since nothing here is schema-enforced at the API level.
 */
function parseConsolidationResponse(text: string): ParsedConsolidation {
	const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	const parsed: unknown = JSON.parse(cleaned);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Consolidation response was not a JSON object");
	}
	const obj = parsed as Record<string, unknown>;

	const facts: ParsedFact[] = Array.isArray(obj.facts)
		? obj.facts
				.filter(
					(f): f is Record<string, unknown> =>
						typeof f === "object" &&
						f !== null &&
						typeof (f as Record<string, unknown>).id === "string" &&
						typeof (f as Record<string, unknown>).subject === "string",
				)
				.map((f) => ({
					id: f.id as string,
					subject: f.subject as string,
					body: typeof f.body === "string" ? f.body : undefined,
				}))
		: [];

	const edges: ParsedEdge[] = Array.isArray(obj.edges)
		? obj.edges
				.filter(
					(e): e is Record<string, unknown> =>
						typeof e === "object" &&
						e !== null &&
						typeof (e as Record<string, unknown>).from === "string" &&
						typeof (e as Record<string, unknown>).to === "string" &&
						isEdgeRelation((e as Record<string, unknown>).rel),
				)
				.map((e) => ({ from: e.from as string, to: e.to as string, rel: e.rel as EdgeRelation }))
		: [];

	const episodeValue = obj.episode;
	if (typeof episodeValue !== "object" || episodeValue === null) {
		throw new Error("Consolidation response is missing an episode");
	}
	const episodeObj = episodeValue as Record<string, unknown>;
	if (
		typeof episodeObj.summary !== "string" ||
		typeof episodeObj.startedAt !== "string" ||
		typeof episodeObj.endedAt !== "string"
	) {
		throw new Error("Consolidation response's episode is missing required fields");
	}
	const relatedFactIds = Array.isArray(episodeObj.relatedFactIds)
		? episodeObj.relatedFactIds.filter((id): id is string => typeof id === "string")
		: undefined;

	return {
		facts,
		edges,
		episode: {
			summary: episodeObj.summary,
			startedAt: episodeObj.startedAt,
			endedAt: episodeObj.endedAt,
			relatedFactIds,
		},
	};
}

/** Writes the parsed response to the memory/episodic stores, resolving local fact ids to real node ids. */
function applyConsolidationResult(
	parsed: ParsedConsolidation,
	memoryStore: FileMemoryStore,
	episodicStore: EpisodicStore,
): void {
	const idMap = new Map<string, string>();
	for (const fact of parsed.facts) {
		const node = memoryStore.createNode({ subject: fact.subject, body: fact.body });
		idMap.set(fact.id, node.id);
	}
	const resolve = (id: string): string => idMap.get(id) ?? id;

	for (const edge of parsed.edges) {
		memoryStore.addEdge(resolve(edge.from), { target: resolve(edge.to), rel: edge.rel });
	}

	episodicStore.recordEpisode({
		startedAt: parsed.episode.startedAt,
		endedAt: parsed.episode.endedAt,
		summary: parsed.episode.summary,
		relatedSemanticNodeIds: parsed.episode.relatedFactIds?.map(resolve),
	});
}

/** Filename-safe deterministic id, stable per Channel Session, for OpenRouter cache-affinity only. */
function consolidationSessionAffinityId(channel: string, channelSessionId: string): string {
	return `consolidation-${channel}-${channelSessionId}`.replace(/[^A-Za-z0-9._-]/g, "-");
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
 * Issue #177: tracks channel-session keys with a consolidation pass currently in flight. Necessary
 * because `maybeRunConsolidation` is fire-and-forget (never awaited by its caller) — without this, a
 * new trigger firing before a prior attempt for the same session finished could start an overlapping
 * pass, each holding its own multi-hundred-K-token transcript in memory at once.
 */
const inFlightConsolidations = new Set<string>();

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

/**
 * Issue #177: hard cap on the whole transcript, mirroring mino-oss's own 100K-char cap for the same
 * consolidation-model defect (mino-agent commit 4bca19d, "consolidation prompt cap - deepseek
 * reasoning spiral"). Per-entry truncation (MAX_TOOL_RESULT_CHARS/MAX_TOOL_ARGS_CHARS) bounds tool
 * noise, but user/assistant text is kept in full — a single very long message could still blow past
 * this even within one CONSOLIDATION_TURN_CEILING-sized chunk. Keeps the tail: the most recent turns
 * are more likely to contain what the window was triggered for.
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;

export function capTranscript(text: string): string {
	return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text;
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
 * the live trigger path and backfill — the extraction prompt is identical either way, only how the
 * window and target session are chosen differs.
 */
async function runConsolidationPass(params: {
	channel: string;
	channelSessionId: string;
	window: SessionMessageEntry[];
	modelRuntime: ModelRuntime;
	memoryStore: FileMemoryStore;
	episodicStore: EpisodicStore;
}): Promise<void> {
	const { channel, channelSessionId, window, modelRuntime, memoryStore, episodicStore } = params;
	if (window.length === 0) return;

	const transcript = capTranscript(entriesToTranscript(window));
	const model = resolveConsolidationModel(modelRuntime);
	const existingNodes = buildExistingNodesSection(memoryStore, transcript);

	const promptText = `${CONSOLIDATION_INSTRUCTIONS}\n\n--- Existing memory nodes ---\n${existingNodes}\n\n--- Conversation window ---\n${transcript}`;
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
	};
	// toolChoice: "none" and no `reasoning` option — omitting `reasoning` entirely still lands the
	// model in its off/disabled state on the wire for every thinkingFormat branch that supports one
	// (see openai-completions.ts's per-format reasoning handling), which is what issue #177 needed
	// explicitly for this same model; no separate cast is needed for a single non-agentic call.
	const streamOptions: SimpleStreamOptions = {
		maxTokens: model.maxTokens,
		toolChoice: "none",
		sessionId: consolidationSessionAffinityId(channel, channelSessionId),
	};

	if (process.env.THEOSES_DEBUG_CONSOLIDATION) {
		console.error("CONSOLIDATION_PROMPT", promptText.slice(0, 500));
	}

	const response = await retryAssistantCall(
		() => modelRuntime.completeSimple(model, context, streamOptions),
		CONSOLIDATION_RETRY_POLICY,
		undefined,
	);

	if (response.stopReason === "aborted") throw new Error("Consolidation pass was aborted");
	if (response.stopReason === "error")
		throw new Error(`Consolidation pass errored: ${response.errorMessage ?? "unknown error"}`);

	const parsed = parseConsolidationResponse(contentText(response.content));
	applyConsolidationResult(parsed, memoryStore, episodicStore);
}

async function runIfTriggered(options: MaybeRunConsolidationOptions): Promise<void> {
	const { channel, channelSessionId, userMessageText, mainSessionManager, modelRuntime } = options;

	// Checked and claimed before any `await` in this function — otherwise two near-simultaneous
	// calls for the same key could both pass this check before either reaches the `add`, since the
	// guard would only be reached after already yielding once (e.g. to EpisodicStore.create()).
	const key = channelSessionKey(channel, channelSessionId);
	if (inFlightConsolidations.has(key)) return;
	inFlightConsolidations.add(key);

	try {
		const memoryStore = options.memoryStore ?? new FileMemoryStore();
		const episodicStore = options.episodicStore ?? (await EpisodicStore.create());

		const checkpoints = readCheckpoints();
		const entry = checkpoints[key];
		if (entry?.lastFailureAt && Date.now() - Date.parse(entry.lastFailureAt) < CONSOLIDATION_FAILURE_COOLDOWN_MS) {
			return;
		}
		const lastEntryId = entry?.lastEntryId ?? null;

		const branch = mainSessionManager.getBranch();
		const startIndex = lastEntryId ? branch.findIndex((e) => e.id === lastEntryId) + 1 : 0;
		const window = branch.slice(startIndex).filter((e): e is SessionMessageEntry => e.type === "message");
		if (window.length === 0) return;

		if (!shouldTriggerConsolidation(userMessageText, window.length)) return;

		// Issue #177: chunk the live trigger the same way backfillFromSessionLog already does, so a
		// live pass can never balloon past CONSOLIDATION_TURN_CEILING messages regardless of how long
		// a failing checkpoint left the window growing. Each chunk's checkpoint advances immediately
		// on success, so a later chunk's failure doesn't roll back progress already made.
		for (let start = 0; start < window.length; start += CONSOLIDATION_TURN_CEILING) {
			const chunk = window.slice(start, start + CONSOLIDATION_TURN_CEILING);
			try {
				await runConsolidationPass({
					channel,
					channelSessionId,
					window: chunk,
					modelRuntime,
					memoryStore,
					episodicStore,
				});
			} catch (error) {
				writeFailure(key, new Date().toISOString());
				throw error;
			}
			const lastChunkEntry = chunk[chunk.length - 1];
			if (lastChunkEntry) writeCheckpoint(key, lastChunkEntry.id);
		}
	} finally {
		inFlightConsolidations.delete(key);
	}
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
 * run sequentially, not in parallel: each chunk's prompt embeds a fresh keyword-narrowed read of
 * the memory store (`buildExistingNodesSection`), so it needs to see facts the prior chunk already
 * wrote, for dedup/supersession continuity within one file.
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
			channel: header.channel,
			channelSessionId: header.channelSessionId,
			window: chunk,
			modelRuntime: options.modelRuntime,
			memoryStore,
			episodicStore,
		});
	}
}
