/**
 * Task-closure / topic-shift detection (issue #186).
 *
 * Compaction (./compaction/compaction.ts) chains its Goal/Progress summary forward
 * indefinitely across a session. That's correct mid-task (coding-agent's tool-heavy tasks
 * legitimately need the continuity), but wrong once a task is done and the user moves on to
 * something unrelated: the old Goal keeps propagating into every future compaction pass and
 * biases the model on requests that have nothing to do with it ("context rot").
 *
 * The existing task-completion signal (memory-consolidation.ts's shouldTriggerConsolidation:
 * phrase-matching on "thanks"/"that's all"/etc.) only feeds long-term memory extraction and
 * never resets the live compaction chain — and as a signal it's too weak on its own (false
 * positives on a mid-task "thanks"; false negatives on a silent topic pivot with no closing
 * phrase at all).
 *
 * This module is the fix for the false-negative gap: on every user turn, it asks whether the new
 * message still relates to a rolling "current task" descriptor it maintains itself, and — on a
 * detected shift — writes a marker compaction can use to stop chaining the old Goal forward. Both
 * the descriptor and the marker are stored as CustomEntry (session-manager.ts), the same
 * mechanism extensions already use to persist state across session reloads without participating
 * in LLM context.
 *
 * The related/unrelated judgment is a TypeSafe Jev Noul call (see callJevRelated below, via
 * jev-client.ts), not a text-generating model: it's a narrow, calibrated yes/no question with no
 * free-form output to parse, and costs a fraction of a cent per turn. Jev cannot generate the
 * rolling one-line task summary itself (System One models don't produce text), so that half still
 * goes to a small text-generating model (callSummaryModel), now asked only for the sentence, not a
 * JSON boolean.
 *
 * SHADOW MODE (issue #186, Q15): this module always runs and always writes its entries, but
 * compaction.ts only *logs* what it would have done with a detected boundary — it does not yet
 * change compaction's live behavior. That flip happens once the detector's accuracy has been
 * validated against real traffic.
 */

import { type Api, contentText, type Model, retryAssistantCall } from "theoses-ai";
import type { Context, SimpleStreamOptions } from "theoses-ai/compat";
import { askJevNoul } from "./jev-client.ts";
import { resolveConsolidationModel } from "./memory-consolidation.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { CustomEntry, SessionEntry, SessionManager } from "./session-manager.ts";

export const TASK_DESCRIPTOR_CUSTOM_TYPE = "task_descriptor";
export const TASK_BOUNDARY_CUSTOM_TYPE = "task_boundary";

/** Data payload of a `task_descriptor` CustomEntry: the rolling "what we're doing" one-liner,
 * rewritten every turn regardless of verdict so it never goes stale mid-task. */
export interface TaskDescriptorData {
	summary: string;
}

/** Data payload of a `task_boundary` CustomEntry: written only when the detector judges the new
 * message unrelated to the current descriptor. `beforeEntryId` anchors the logical reset point
 * to the entry that started the new task, even though this entry is physically appended later
 * (the detector runs async, after that entry's reply was already sent) — compaction resolves the
 * anchor positionally via `beforeEntryId`, the same way it already resolves `firstKeptEntryId`. */
export interface TaskBoundaryData {
	taskSummary: string;
	beforeEntryId: string;
}

/**
 * Resolves the model used for the rolling task-summary sentence only (the related/unrelated
 * judgment itself goes to Jev — see callJevRelated). Reuses memory-consolidation's model (same
 * cheap/fast tier, same cost-strict OpenRouter provider routing) until a dedicated model is
 * chosen (tracked in issue #186 — the detection *mechanism* is model-agnostic by design; only the
 * model id is pending).
 */
export function resolveTaskBoundaryModel(modelRuntime: ModelRuntime): Model<Api> {
	return resolveConsolidationModel(modelRuntime);
}

/** Single-attempt: this call is fire-and-forget on every turn, so a failed attempt is
 * effectively retried by construction on the next turn (see maybeDetectTaskBoundary). Mirrors
 * the "no boundary on failure" default from issue #186 Q13. */
const TASK_BOUNDARY_RETRY_POLICY = { enabled: true, maxRetries: 1, baseDelayMs: 500 };

/**
 * Noul threshold for calling a message "related". Set above the neutral 0.5 midpoint to mirror
 * the old prompt's explicit bias ("err toward related: false when genuinely unsure") now that the
 * bias is an explicit, tunable number in code instead of an instruction the model had to remember
 * to follow: a false "unrelated" verdict just resets the rolling descriptor early (cheap), while a
 * missed shift lets a stale Goal keep biasing the model on unrelated requests (issue #186's actual
 * context-rot problem).
 */
const JEV_RELATED_THRESHOLD = 0.6;

/**
 * Half-width of the band around JEV_RELATED_THRESHOLD treated as "too close to call". Noul has no
 * separate confidence field (TypeSafe's own docs: the probability doubles as confidence via its
 * distance from 0.5) — inside this band Jev's verdict is barely more than a coin flip relative to
 * the threshold, so runDetection escalates to the larger text model instead of trusting the raw
 * split. Outside the band, Jev's verdict is used as-is (no extra call, no added latency/cost).
 */
const JEV_AMBIGUOUS_BAND = 0.1;

/**
 * Asks Jev whether `newUserMessage` still relates to `currentDescriptor`. Returns the raw noul
 * probability (0 = unrelated, 1 = related), or undefined on any failure — same "write nothing,
 * retried naturally next turn" contract the rest of this module already uses.
 */
async function callJevRelated(currentDescriptor: string, newUserMessage: string): Promise<number | undefined> {
	const state = { current_task: currentDescriptor || "(none tracked yet)", new_message: newUserMessage };
	if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
		console.error("TASK_BOUNDARY_JEV_REQUEST", JSON.stringify(state));
	}
	return askJevNoul(state, "Does `new_message` continue or relate to `current_task`?");
}

const ESCALATED_RELATED_INSTRUCTIONS = `Does the new message below continue or relate to the current task? Reply with ONLY the single word "true" or "false" — no quotes, no commentary, no markdown.`;

/**
 * Escalation path for a Jev verdict landing inside JEV_AMBIGUOUS_BAND: asks the same model
 * callSummaryModel already uses for a direct yes/no, since Jev's own probability was too close to
 * JEV_RELATED_THRESHOLD to trust on its own. Returns undefined on failure or an unparseable reply
 * — callers fall back to the raw Jev verdict in that case, never blocking the turn on escalation.
 */
async function callEscalatedRelated(
	modelRuntime: ModelRuntime,
	currentDescriptor: string,
	newUserMessage: string,
	sessionAffinityId: string,
): Promise<boolean | undefined> {
	const model = resolveTaskBoundaryModel(modelRuntime);
	const promptText = `${ESCALATED_RELATED_INSTRUCTIONS}\n\nCurrent task: ${currentDescriptor || "(none tracked yet)"}\n\nNew message: ${newUserMessage}`;
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
	};
	const streamOptions: SimpleStreamOptions = {
		maxTokens: model.maxTokens,
		toolChoice: "none",
		sessionId: sessionAffinityId,
	};

	if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
		console.error("TASK_BOUNDARY_ESCALATION_PROMPT", promptText.slice(0, 500));
	}

	try {
		const response = await retryAssistantCall(
			() => modelRuntime.completeSimple(model, context, streamOptions),
			TASK_BOUNDARY_RETRY_POLICY,
			undefined,
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		const text = contentText(response.content).trim().toLowerCase();
		if (text.startsWith("true")) return true;
		if (text.startsWith("false")) return false;
		return undefined;
	} catch (error) {
		console.error("Task-boundary escalation call failed:", error instanceof Error ? error.message : error);
		return undefined;
	}
}

const TASK_SUMMARY_INSTRUCTIONS_RELATED = `The new message below continues the current task. Write an updated one-line description of the task, refined to reflect its current state (it may have evolved, e.g. gained a sub-step). Reply with ONLY the single self-contained sentence — no quotes, no commentary, no markdown.`;

const TASK_SUMMARY_INSTRUCTIONS_NEW = `The new message below starts a task unrelated to the current one. Write a one-line description of this NEW task. Reply with ONLY the single self-contained sentence — no quotes, no commentary, no markdown.`;

/** Strips wrapping quotes a model sometimes adds despite being told not to. */
function cleanSummary(text: string): string {
	return text
		.trim()
		.replace(/^["'“](.*)["'”]$/s, "$1")
		.trim();
}

/** Scans a branch for the most recent CustomEntry of the given customType. */
function findLatestCustomEntry<T>(branch: SessionEntry[], customType: string): CustomEntry<T> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === customType) {
			return entry as CustomEntry<T>;
		}
	}
	return undefined;
}

/** Current rolling task descriptor, or "" if none has been written yet (first task in the session). */
export function getTaskDescriptor(branch: SessionEntry[]): string {
	const entry = findLatestCustomEntry<TaskDescriptorData>(branch, TASK_DESCRIPTOR_CUSTOM_TYPE);
	return entry?.data?.summary ?? "";
}

/** Most recent task_boundary entry on the branch, if any. */
export function findLatestTaskBoundary(branch: SessionEntry[]): CustomEntry<TaskBoundaryData> | undefined {
	return findLatestCustomEntry<TaskBoundaryData>(branch, TASK_BOUNDARY_CUSTOM_TYPE);
}

/** Entry id of the most recent user message on the branch — the anchor for a task_boundary
 * written after that message's reply has already been sent. */
export function findLastUserMessageEntryId(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	return undefined;
}

/** Regenerates the rolling one-line task summary. `related` was already decided by Jev
 * (callJevRelated) — this call only writes the sentence, so its output needs no JSON parsing. */
async function callSummaryModel(
	modelRuntime: ModelRuntime,
	currentDescriptor: string,
	newUserMessage: string,
	related: boolean,
	sessionAffinityId: string,
): Promise<string | undefined> {
	const model = resolveTaskBoundaryModel(modelRuntime);
	const instructions = related ? TASK_SUMMARY_INSTRUCTIONS_RELATED : TASK_SUMMARY_INSTRUCTIONS_NEW;
	const promptText = `${instructions}\n\nCurrent task: ${currentDescriptor || "(none tracked yet)"}\n\nNew message: ${newUserMessage}`;
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
	};
	const streamOptions: SimpleStreamOptions = {
		maxTokens: model.maxTokens,
		toolChoice: "none",
		sessionId: sessionAffinityId,
	};

	if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
		console.error("TASK_BOUNDARY_SUMMARY_PROMPT", promptText.slice(0, 500));
	}

	try {
		const response = await retryAssistantCall(
			() => modelRuntime.completeSimple(model, context, streamOptions),
			TASK_BOUNDARY_RETRY_POLICY,
			undefined,
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		const summary = cleanSummary(contentText(response.content));
		return summary || undefined;
	} catch (error) {
		console.error("Task-boundary summary call failed:", error instanceof Error ? error.message : error);
		return undefined;
	}
}

export interface MaybeDetectTaskBoundaryOptions {
	channel: string;
	channelSessionId: string;
	/** The just-sent user message text to judge against the current task descriptor. */
	userMessageText: string;
	/** Entry id of that user message in the session log — the anchor for a written boundary. */
	userMessageEntryId: string;
	mainSessionManager: SessionManager;
	modelRuntime: ModelRuntime;
}

const inFlightDetections = new Set<string>();

/**
 * Fire-and-forget, one call per user turn (issue #186 Q8: sampling would miss pivots between
 * checks). On success, always refreshes the rolling task_descriptor (Q9); additionally writes a
 * task_boundary marker when the verdict is "unrelated" (Q11: single-shot, no debounce). On any
 * failure, writes nothing — the next turn's call is effectively a retry (Q13).
 */
export function maybeDetectTaskBoundary(options: MaybeDetectTaskBoundaryOptions): void {
	void runDetection(options).catch((error) => {
		console.error(
			`Task-boundary detection failed for ${options.channel}:${options.channelSessionId}:`,
			error instanceof Error ? error.message : error,
		);
	});
}

async function runDetection(options: MaybeDetectTaskBoundaryOptions): Promise<void> {
	const { channel, channelSessionId, userMessageText, userMessageEntryId, mainSessionManager, modelRuntime } = options;
	const key = `${channel}:${channelSessionId}`;
	if (inFlightDetections.has(key)) return;
	inFlightDetections.add(key);

	try {
		const branch = mainSessionManager.getBranch();
		const currentDescriptor = getTaskDescriptor(branch);

		const jevNoul = await callJevRelated(currentDescriptor, userMessageText);
		if (jevNoul === undefined) return; // failure: write nothing, retried naturally next turn
		let related = jevNoul >= JEV_RELATED_THRESHOLD;

		if (Math.abs(jevNoul - JEV_RELATED_THRESHOLD) < JEV_AMBIGUOUS_BAND) {
			const escalated = await callEscalatedRelated(modelRuntime, currentDescriptor, userMessageText, key);
			if (escalated !== undefined) {
				if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
					console.error(`[task-boundary] jev noul=${jevNoul} ambiguous, escalated related=${escalated} for ${key}`);
				}
				related = escalated;
			}
		}

		if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
			console.error(`[task-boundary] jev noul=${jevNoul} related=${related} for ${key}`);
		}

		const summary = await callSummaryModel(modelRuntime, currentDescriptor, userMessageText, related, key);
		if (!summary) return; // failure: write nothing, retried naturally next turn

		mainSessionManager.appendCustomEntry(TASK_DESCRIPTOR_CUSTOM_TYPE, {
			summary,
		} satisfies TaskDescriptorData);

		if (!related) {
			mainSessionManager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, {
				taskSummary: summary,
				beforeEntryId: userMessageEntryId,
			} satisfies TaskBoundaryData);

			if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
				console.error(`[task-boundary] shift detected for ${key} before entry ${userMessageEntryId}: "${summary}"`);
			}
		}
	} finally {
		inFlightDetections.delete(key);
	}
}
