/**
 * Per-chat turn scheduling and /stop bookkeeping for the Telegram adapter, extracted out of
 * createTelegramBot's closure. Deliberately Telegram-only (not shared with the dashboard
 * adapter, whose needs - one promise-chain queue, unconditional abort, no per-message stop, no
 * typing indicator, no auto-resume - are much thinner) and behavior-preserving: same state, same
 * timing, just given a narrow interface instead of ten free-floating Maps mutated throughout a
 * 460-line handler. No grammy or AgentSession imports, so it's testable with plain synchronous
 * calls.
 */

/** How long a stop request marked against a still-queued message stays live before it expires unconsumed. */
const STOP_REQUEST_TTL_MS = 30_000;

export function createTurnQueue(options: { stopRequestTtlMs?: number } = {}) {
	const stopRequestTtlMs = options.stopRequestTtlMs ?? STOP_REQUEST_TTL_MS;

	const queues = new Map<string, Promise<void>>();
	const queuedMessageIds = new Map<string, number[]>();
	const queueDepth = new Map<string, number>();
	const stopRequested = new Map<string, { messageId: number; timer: ReturnType<typeof setTimeout> }>();
	const haltedByStop = new Set<string>();
	const runningTool = new Map<string, string | undefined>();
	const pendingResumes = new Map<string, ReturnType<typeof setTimeout>>();

	function removeQueuedMessage(chat: string, messageId: number): void {
		const queued = queuedMessageIds.get(chat);
		if (!queued) return;
		const remaining = queued.filter((id) => id !== messageId);
		if (remaining.length > 0) queuedMessageIds.set(chat, remaining);
		else queuedMessageIds.delete(chat);
	}

	return {
		/**
		 * Track `messageId` as queued for `chat` and chain `job` after any prior turn queued for that
		 * chat. The caller is responsible for calling `dequeue(chat, messageId)` from inside `job`
		 * once it starts running (before consulting `consumeStopRequest`), and for depth bookkeeping
		 * via `trackDepth`/`untrackDepth` around the whole turn (including turns skipped before `job`
		 * ever runs, e.g. by `/model` or a stop request).
		 */
		enqueue(chat: string, messageId: number, job: () => Promise<void>): Promise<void> {
			const queued = queuedMessageIds.get(chat) ?? [];
			queued.push(messageId);
			queuedMessageIds.set(chat, queued);
			const previous = queues.get(chat) ?? Promise.resolve();
			const next = previous.then(job);
			queues.set(
				chat,
				next.catch(() => {}),
			);
			return next;
		},

		/** Call once a queued turn starts running, before consulting `consumeStopRequest`. */
		dequeue: removeQueuedMessage,

		trackDepth(chat: string): void {
			queueDepth.set(chat, (queueDepth.get(chat) ?? 0) + 1);
		},

		/** Call exactly once per turn queued via `enqueue`, whether it ran, was skipped, or errored. */
		untrackDepth(chat: string): void {
			const depth = (queueDepth.get(chat) ?? 1) - 1;
			if (depth > 0) queueDepth.set(chat, depth);
			else queueDepth.delete(chat);
		},

		queueDepth(chat: string): number {
			return queueDepth.get(chat) ?? 0;
		},

		/** The message id of the next turn due to run for `chat`, if any is queued. */
		nextQueuedMessageId(chat: string): number | undefined {
			return queuedMessageIds.get(chat)?.[0];
		},

		/** Mark `messageId` (a still-queued turn) to be skipped when its turn comes. */
		requestStop(chat: string, messageId: number): void {
			const previous = stopRequested.get(chat);
			if (previous) clearTimeout(previous.timer);
			const timer = setTimeout(() => {
				const request = stopRequested.get(chat);
				if (request?.messageId === messageId) stopRequested.delete(chat);
			}, stopRequestTtlMs);
			stopRequested.set(chat, { messageId, timer });
		},

		/** True (and clears the request) if `messageId`'s queued turn was marked to be skipped. */
		consumeStopRequest(chat: string, messageId: number): boolean {
			const request = stopRequested.get(chat);
			if (!request || request.messageId !== messageId) return false;
			clearTimeout(request.timer);
			stopRequested.delete(chat);
			return true;
		},

		/** Set right before abort() so the in-flight turn skips sending its own (partial/empty) reply. */
		markHaltedByStop(chat: string): void {
			haltedByStop.add(chat);
		},

		/** True (and clears the flag) if `chat`'s in-flight turn was just aborted by /stop. */
		consumeHaltedByStop(chat: string): boolean {
			return haltedByStop.delete(chat);
		},

		setRunningTool(chat: string, name: string | undefined): void {
			if (name === undefined) runningTool.delete(chat);
			else runningTool.set(chat, name);
		},

		/** The tool name currently running for `chat`, for a /stop reply's "Was running: X" report. */
		getRunningTool(chat: string): string | undefined {
			return runningTool.get(chat);
		},

		/** Schedule `run` as chat's pending auto-resume; replaces (does not stack with) an existing one. */
		scheduleAutoResume(chat: string, run: () => void, delayMs: number): void {
			pendingResumes.set(
				chat,
				setTimeout(() => {
					pendingResumes.delete(chat);
					run();
				}, delayMs),
			);
		},

		/** True (and cancels it) if `chat` had a pending auto-resume. */
		cancelAutoResume(chat: string): boolean {
			const pending = pendingResumes.get(chat);
			if (!pending) return false;
			clearTimeout(pending);
			pendingResumes.delete(chat);
			return true;
		},
	};
}

export type TurnQueue = ReturnType<typeof createTurnQueue>;
