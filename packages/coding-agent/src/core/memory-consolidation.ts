import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { contentText, type ToolCall, type ToolResultMessage } from "theoses-ai";
import { getAgentDir } from "../config.ts";
import { backgroundCall } from "./background-call.ts";
import { describeResponseShape, recordBackgroundFailure } from "./background-failure-log.ts";
import { EpisodicStore } from "./episodic-store.ts";
import { askJevChoice, askJevNoul } from "./jev-client.ts";
import { createMemoryWriteGate, isMemoryGateEnabled } from "./memory-gate.ts";
import { EDGE_RELATION_DESCRIPTIONS, EDGE_RELATIONS, type EdgeRelation, FileMemoryStore } from "./memory-store.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { SessionManager, type SessionMessageEntry } from "./session-manager.ts";
import { parseStructuredJson } from "./structured-output.ts";

/**
 * The Durable Memory distiller: the Jev trigger (`shouldTriggerConsolidation`), transcript building, and the
 * one structured-output call that turns a window of session messages into facts/edges/an episode
 * (`runConsolidationPass`, `applyConsolidationResult`). Single-flight, the failure cooldown, chunking, and
 * which entries are unpromoted all live in memory-promotion.ts, which is the only caller of this module's live
 * path — see its header comment for the two triggers (compaction, Turn Settlement) that reach it.
 * `backfillFromSessionLog` below is the one exception: a separate, explicit operation over a historical
 * session-log file that calls the same distiller directly and records no promoted ranges.
 */

/**
 * Issue #180: single-attempt, single-turn retry policy for the one structured-output call a
 * consolidation pass now makes. Mirrors SettingsManager.getRetrySettings()'s defaults (enabled,
 * 3 retries, 2s base delay) — this module runs headless in the background and has no
 * SettingsManager instance of its own to read those from.
 */
const CONSOLIDATION_RETRY_POLICY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

/** Rare-case fallback for sessions that never signal completion. Checked before the Jev call
 * below (no network round trip needed) so a long-running session is always eventually flushed
 * regardless of what the user says. */
export const CONSOLIDATION_TURN_CEILING = 70;

/**
 * Noul threshold for treating the message as a completion signal. Mirrors task-boundary-
 * detector.ts's JEV_RELATED_THRESHOLD reasoning: a false trigger just runs consolidation a little
 * early (cheap — it dedupes against existing memory nodes anyway), while a missed signal only
 * delays capture until CONSOLIDATION_TURN_CEILING, so there's no strong reason to bias this one
 * off the neutral midpoint the way task-boundary's is.
 */
const CONSOLIDATION_TRIGGER_THRESHOLD = 0.5;

/**
 * Replaces the old phrase-matching trigger ("thanks"/"that's all"/etc. as a case-insensitive
 * substring anywhere in the message) with a TypeSafe Jev Noul call. The keyword list had the same
 * two failure modes task-boundary-detector.ts's old prompt-based approach did: false positives
 * ("thanks for that, now also fix the login bug" contains "thanks" but isn't a sign-off) and false
 * negatives (a real wrap-up with no matching phrase never fires). Jev reads the message's actual
 * meaning instead of matching substrings, at a fraction of a cent per turn.
 */
export async function shouldTriggerConsolidation(
	userMessageText: string,
	turnsSinceCheckpoint: number,
): Promise<boolean> {
	if (turnsSinceCheckpoint >= CONSOLIDATION_TURN_CEILING) return true;
	const noul = await askJevNoul(
		{ message: userMessageText },
		"Does `message` signal that the user considers the current task or conversation finished (e.g. thanks, a sign-off, or explicit confirmation of completion), rather than continuing it?",
		{ label: "consolidation-trigger" },
	);
	if (noul === undefined) return false; // Jev call failed: skip this turn, the turn ceiling still catches a long session eventually
	return noul >= CONSOLIDATION_TRIGGER_THRESHOLD;
}

// ---------------------------------------------------------------------------
// The distiller: transcript building and the one structured-output call.
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

export interface ParsedFact {
	id: string;
	subject: string;
	body?: string;
}

export interface ParsedEdge {
	from: string;
	to: string;
	rel: EdgeRelation;
}

export interface ParsedEpisode {
	summary: string;
	startedAt: string;
	endedAt: string;
	relatedFactIds?: string[];
}

export interface ParsedConsolidation {
	facts: ParsedFact[];
	edges: ParsedEdge[];
	episode: ParsedEpisode;
}

function isEdgeRelation(value: unknown): value is EdgeRelation {
	return typeof value === "string" && (EDGE_RELATIONS as readonly string[]).includes(value);
}

/**
 * Structured-output parsing (fence stripping, near-miss repair, failure diagnostics) lives in
 * structured-output.ts, shared with the distillation path. Shape is validated field-by-field
 * rather than trusting the whole payload, since json_object mode is a nudge, not schema
 * enforcement (see issue #250).
 */
/** True when every transcript line is only its `[timestamp] role:` prefix, i.e. the window carries no text. */
export function hasConsolidationContent(transcript: string): boolean {
	return transcript.split("\n").some((line) => line.replace(/^\[[^\]]*\]\s*\w+:/, "").trim().length > 0);
}

/**
 * True when the model answered with a JSON object that has an empty (or absent) `facts` and `edges` and no
 * `episode`: the `{}` DeepInfra returns for a near-empty window. A response with facts but no episode is
 * still a real failure and is left for parseConsolidationResponse to reject.
 */
export function isEmptyConsolidationResponse(text: string): boolean {
	let parsed: unknown;
	try {
		parsed = parseStructuredJson(text, "Memory consolidation");
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	const isEmptyList = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
	return (obj.episode === undefined || obj.episode === null) && isEmptyList(obj.facts) && isEmptyList(obj.edges);
}

function parseConsolidationResponse(text: string, stopReason?: string): ParsedConsolidation {
	const parsed: unknown = parseStructuredJson(text, "Memory consolidation");
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`Consolidation response was not a JSON object (${describeResponseShape(text, stopReason)})`);
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
		throw new Error(`Consolidation response is missing an episode (${describeResponseShape(text, stopReason)})`);
	}
	const episodeObj = episodeValue as Record<string, unknown>;
	if (
		typeof episodeObj.summary !== "string" ||
		typeof episodeObj.startedAt !== "string" ||
		typeof episodeObj.endedAt !== "string"
	) {
		throw new Error(
			`Consolidation response's episode is missing required fields (${describeResponseShape(text, stopReason)})`,
		);
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

/**
 * Confidence floor a real override would use, once one is enabled. Currently only used to label
 * each shadow-log line with "would this threshold have overridden" — two hand-picked staging
 * probes (2026-09-18) aren't enough evidence to trust a number against real data, so
 * confirmEdgeRelation below never actually overrides yet (see SHADOW MODE comment). This constant
 * exists so the threshold under evaluation is a single, greppable place, not scattered literals.
 */
const EDGE_RELATION_CONFIDENCE_THRESHOLD = 0.4;

function edgeRelationShadowLogPath(): string {
	return (
		process.env.THEOSES_EDGE_RELATION_SHADOW_LOG ?? join(dirname(getAgentDir()), "edge-relation-shadow-log.jsonl")
	);
}

interface EdgeRelationShadowLogEntry {
	timestamp: string;
	from: string;
	to: string;
	proposedRel: EdgeRelation;
	jevChoice: string | null;
	jevConfidence: number | null;
	agrees: boolean | null;
	wouldOverrideAtThreshold: boolean;
}

/** Appends one shadow-log line, truncated to keep entries reviewable and the file from ballooning
 * on long node texts. Never throws — a logging failure must not block a real consolidation pass. */
function logEdgeRelationShadow(entry: EdgeRelationShadowLogEntry): void {
	try {
		const path = edgeRelationShadowLogPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (error) {
		console.error("Edge-relation shadow log write failed:", error instanceof Error ? error.message : error);
	}
}

/**
 * SHADOW MODE (same pattern as task-boundary-detector.ts's issue #186 Q15): always calls Jev's
 * Choice primitive and always logs the comparison against DeepSeek's proposed `rel`, but always
 * returns `proposedRel` unchanged — it does not yet affect what gets written to the memory graph.
 *
 * Two live measurements against real staging edges (2026-09-18) ruled out both obvious fixes:
 * bare `from`/`to` state agreed with DeepSeek only 42% of the time with confidence barely
 * correlated to correctness (avg 0.60 on agreement vs 0.49 on disagreement); adding a raw,
 * unfocused 6000-char transcript tail as a third `context` field (thinking Jev just needed more
 * signal) made it *worse* (41% agreement, gap down to 0.49 vs 0.43) — consistent with TypeSafe's
 * own state guidance (docs/concepts/state: "include only information the model needs... extraneous
 * details risk diluting decision quality"), since a raw transcript dump is exactly the unfocused
 * shape that page warns against. The remaining, more likely explanation: EDGE_RELATION_DESCRIPTIONS'
 * 8 categories (depends_on/used_in/located_at/supersedes/...) are underspecified enough that
 * DeepSeek and Jev land on different-but-defensible picks for the same fact pair regardless of
 * how much text either sees — a vocabulary problem, not a state-shape problem. Left in shadow mode
 * pending a redesigned, less-overlapping relation vocabulary; do not enable a real override on the
 * current EDGE_RELATION_DESCRIPTIONS without re-measuring first.
 */
async function confirmEdgeRelation(fromText: string, toText: string, proposedRel: EdgeRelation): Promise<EdgeRelation> {
	const result = await askJevChoice(
		{ from: fromText, to: toText },
		"What relation best describes how `from` relates to `to`?",
		EDGE_RELATION_DESCRIPTIONS,
		{ label: "edge-relation" },
	);

	logEdgeRelationShadow({
		timestamp: new Date().toISOString(),
		from: fromText.slice(0, 200),
		to: toText.slice(0, 200),
		proposedRel,
		jevChoice: result?.choice ?? null,
		jevConfidence: result?.confidence ?? null,
		agrees: result ? result.choice === proposedRel : null,
		wouldOverrideAtThreshold: result !== undefined && result.confidence >= EDGE_RELATION_CONFIDENCE_THRESHOLD,
	});

	return proposedRel;
}

/**
 * Writes the parsed response to the memory/episodic stores, resolving local fact ids to real node ids.
 *
 * The model is asked not to re-emit a fact that already exists, but it only sees a handful of keyword-
 * matched subjects, so restatements got through: 11% of the real store was duplicates. A fact that only
 * restates a stored node (see memory-dedup.ts: identical after normalising, or a conservative near match
 * that adds no words) is not written again; its local id resolves to the existing node, so edges and the
 * episode attach to it. A restatement that adds words is a more specific fact and is still created.
 */
export async function applyConsolidationResult(
	parsed: ParsedConsolidation,
	memoryStore: FileMemoryStore,
	episodicStore: EpisodicStore,
): Promise<void> {
	const idMap = new Map<string, string>();
	const gate = createMemoryWriteGate(memoryStore.listNodes(), { jev: isMemoryGateEnabled() });
	let reused = 0;
	let superseded = 0;
	for (const fact of parsed.facts) {
		const verdict = await gate.check(fact.subject);
		if (verdict.action === "reuse") {
			const existing = verdict.existing;
			idMap.set(fact.id, existing.id);
			reused++;
			// Losslessly adopt an elaboration the stored node lacks.
			if (fact.body && !existing.body) memoryStore.writeNode({ ...existing, body: fact.body });
			continue;
		}
		const node = memoryStore.createNode({ subject: fact.subject, body: fact.body });
		if (verdict.action === "supersede") {
			memoryStore.addEdge(node.id, { target: verdict.existing.id, rel: "supersedes" });
			superseded++;
		}
		gate.noteStored(node);
		idMap.set(fact.id, node.id);
	}
	if (reused > 0) console.error(`[memory-dedup] reused ${reused} stored node(s) for facts that only restate them`);
	if (superseded > 0) console.error(`[memory-gate] ${superseded} new fact(s) replace a less detailed stored node`);
	const resolve = (id: string): string => idMap.get(id) ?? id;

	/** Local facts aren't real nodes yet when edges are confirmed, so their text comes from the
	 * parsed response itself; already-existing nodes are read back from the store. */
	const factById = new Map(parsed.facts.map((f) => [f.id, f]));
	const nodeText = (id: string): string => {
		const fact = factById.get(id);
		if (fact) return fact.body ? `${fact.subject} — ${fact.body}` : fact.subject;
		const node = memoryStore.getNode(id);
		return node ? (node.body ? `${node.subject} — ${node.body}` : node.subject) : id;
	};

	for (const edge of parsed.edges) {
		// Two facts that were merged into one stored node would otherwise become a self-edge.
		if (resolve(edge.from) === resolve(edge.to)) continue;
		const rel = await confirmEdgeRelation(nodeText(edge.from), nodeText(edge.to), edge.rel);
		memoryStore.addEdge(resolve(edge.from), { target: resolve(edge.to), rel });
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
export async function runConsolidationPass(params: {
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
	// Issue #315: a chunk with no text (a stray tool result or custom entry) gives the model nothing to
	// summarize, and DeepInfra answers it with `{}`. There is nothing to record, so skip the call; the
	// caller still records these entries as promoted.
	if (!hasConsolidationContent(transcript)) return;
	const existingNodes = buildExistingNodesSection(memoryStore, transcript);

	const promptText = `${CONSOLIDATION_INSTRUCTIONS}\n\n--- Existing memory nodes ---\n${existingNodes}\n\n--- Conversation window ---\n${transcript}`;

	if (process.env.THEOSES_DEBUG_CONSOLIDATION) {
		console.error("CONSOLIDATION_PROMPT", promptText.slice(0, 500));
	}

	const response = await backgroundCall(modelRuntime, {
		caller: "consolidation",
		prompt: promptText,
		sessionId: consolidationSessionAffinityId(channel, channelSessionId),
		retry: CONSOLIDATION_RETRY_POLICY,
		// Issue #250: enforce JSON-object mode at the API level. Consolidation's output is a
		// single JSON object; leaving it to sampling is what produced the intermittent
		// "Expected ',' or '}' after property value" production failures (checkpoint stalls,
		// whole-window re-runs). DeepSeek supports json_object mode without schema enforcement —
		// a nudge, not a guarantee — hence the tolerant parse + diagnostics in parseConsolidationResponse.
		responseFormat: { type: "json_object" },
	});

	if (response.stopReason === "aborted") throw new Error("Consolidation pass was aborted");
	if (response.stopReason === "error")
		throw new Error(`Consolidation pass errored: ${response.errorMessage ?? "unknown error"}`);

	const responseText = contentText(response.content);
	// Issue #315: `{}` (no episode, no facts, no edges) is the model saying there is nothing to record, not a
	// malformed answer. Treating it as an error stalled the checkpoint and started the failure cooldown.
	if (isEmptyConsolidationResponse(responseText)) return;
	let parsed: ParsedConsolidation;
	try {
		parsed = parseConsolidationResponse(responseText, response.stopReason);
	} catch (error) {
		recordBackgroundFailure({
			caller: "consolidation",
			model: response.responseModel ?? response.model,
			provider: response.responseProvider,
			stopReason: response.stopReason,
			error: error instanceof Error ? error.message.slice(0, 300) : String(error),
			reply: responseText,
			promptChars: promptText.length,
		});
		throw error;
	}
	await applyConsolidationResult(parsed, memoryStore, episodicStore);
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
 * Records no promoted ranges — backfill is a separate, explicit operation.
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
