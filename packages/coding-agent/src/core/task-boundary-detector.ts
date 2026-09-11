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
 * This module is the fix for the false-negative gap: on every user turn, it asks a cheap model
 * whether the new message still relates to a rolling "current task" descriptor it maintains
 * itself, and — on a detected shift — writes a marker compaction can use to stop chaining the
 * old Goal forward. Both the descriptor and the marker are stored as CustomEntry (session-
 * manager.ts), the same mechanism extensions already use to persist state across session
 * reloads without participating in LLM context.
 *
 * SHADOW MODE (issue #186, Q15): this module always runs and always writes its entries, but
 * compaction.ts only *logs* what it would have done with a detected boundary — it does not yet
 * change compaction's live behavior. That flip happens once the detector's accuracy has been
 * validated against real traffic.
 */

import { type Api, contentText, type Model, retryAssistantCall } from "theoses-ai";
import type { Context, SimpleStreamOptions } from "theoses-ai/compat";
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
 * Placeholder resolver: reuses memory-consolidation's model (same cheap/fast tier, same
 * cost-strict OpenRouter provider routing) until a dedicated model is chosen (tracked in issue
 * #186 — the detection *mechanism* is model-agnostic by design; only the model id is pending).
 */
export function resolveTaskBoundaryModel(modelRuntime: ModelRuntime): Model<Api> {
	return resolveConsolidationModel(modelRuntime);
}

/** Single-attempt: this call is fire-and-forget on every turn, so a failed attempt is
 * effectively retried by construction on the next turn (see maybeDetectTaskBoundary). Mirrors
 * the "no boundary on failure" default from issue #186 Q13. */
const TASK_BOUNDARY_RETRY_POLICY = { enabled: true, maxRetries: 1, baseDelayMs: 500 };

const TASK_BOUNDARY_INSTRUCTIONS = `You judge whether a new message continues the current task or starts something unrelated.

You are given:
- "Current task": a one-line description of what the conversation has been doing (empty if nothing tracked yet).
- "New message": the user's latest message.

Decide whether the new message still relates to the current task. Err toward "related: false" when genuinely unsure — a wrong "unrelated" is cheap to recover from, a missed shift is not.

Also produce an updated one-line "current task" description:
- If related: refine the description to reflect the task's current state (it may have evolved, e.g. gained a sub-step). Keep it a single self-contained sentence.
- If unrelated: describe the NEW task the message is starting.

Reply with ONLY this JSON:
{"related": <boolean>, "currentTaskSummary": "<one self-contained sentence>"}`;

interface TaskBoundaryResponse {
	related: boolean;
	currentTaskSummary: string;
}

function parseTaskBoundaryResponse(text: string): TaskBoundaryResponse | undefined {
	const trimmed = text
		.trim()
		.replace(/^```json/, "")
		.replace(/```$/, "")
		.trim();
	for (let start = 0; start < trimmed.length; start++) {
		if (trimmed[start] !== "{") continue;
		for (let end = trimmed.length; end > start; end--) {
			if (trimmed[end - 1] !== "}") continue;
			const candidate = trimmed.slice(start, end);
			try {
				const parsed = JSON.parse(candidate);
				if (typeof parsed.related === "boolean" && typeof parsed.currentTaskSummary === "string") {
					return { related: parsed.related, currentTaskSummary: parsed.currentTaskSummary.trim() };
				}
			} catch {
				// keep scanning for a valid object
			}
		}
	}
	return undefined;
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

async function callDetector(
	modelRuntime: ModelRuntime,
	currentDescriptor: string,
	newUserMessage: string,
	sessionAffinityId: string,
): Promise<TaskBoundaryResponse | undefined> {
	const model = resolveTaskBoundaryModel(modelRuntime);
	const promptText = `${TASK_BOUNDARY_INSTRUCTIONS}\n\nCurrent task: ${currentDescriptor || "(none tracked yet)"}\n\nNew message: ${newUserMessage}`;
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
	};
	const streamOptions: SimpleStreamOptions = {
		maxTokens: model.maxTokens,
		toolChoice: "none",
		sessionId: sessionAffinityId,
	};

	if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
		console.error("TASK_BOUNDARY_PROMPT", promptText.slice(0, 500));
	}

	try {
		const response = await retryAssistantCall(
			() => modelRuntime.completeSimple(model, context, streamOptions),
			TASK_BOUNDARY_RETRY_POLICY,
			undefined,
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		return parseTaskBoundaryResponse(contentText(response.content));
	} catch (error) {
		console.error(
			"Task-boundary detection call failed:",
			error instanceof Error ? error.message : error,
		);
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
		const result = await callDetector(modelRuntime, currentDescriptor, userMessageText, key);
		if (!result) return; // failure: write nothing, retried naturally next turn

		mainSessionManager.appendCustomEntry(TASK_DESCRIPTOR_CUSTOM_TYPE, {
			summary: result.currentTaskSummary,
		} satisfies TaskDescriptorData);

		if (!result.related) {
			mainSessionManager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, {
				taskSummary: result.currentTaskSummary,
				beforeEntryId: userMessageEntryId,
			} satisfies TaskBoundaryData);

			if (process.env.THEOSES_DEBUG_TASK_BOUNDARY) {
				console.error(
					`[task-boundary] shift detected for ${key} before entry ${userMessageEntryId}: "${result.currentTaskSummary}"`,
				);
			}
		}
	} finally {
		inFlightDetections.delete(key);
	}
}
