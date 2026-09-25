import type { AgentSessionEvent, ChannelInput, ChannelSession, PromptResult } from "theoses-coding-agent";

/**
 * Per-chat turn scheduling for the Telegram adapter: ordering, /stop, busy state and Auto-Resume.
 * Deliberately Telegram-only - the dashboard adapter needs only the Channel Session's own queue and
 * unconditional abort. No grammy imports: the adapter supplies how to prepare and render a turn, and
 * learns when a chat goes busy or idle (to drive the typing indicator).
 *
 * A turn moves queued -> preparing (the adapter's `prepare`: album wait, session open, downloads) ->
 * running (`session.submit`) -> finishing (the adapter's `finish`). /stop halts the turn that is
 * preparing or running and skips the next queued one; a turn that is only finishing can't be stopped.
 */

/** What a turn submits and how its result is rendered; `undefined` from `prepare` means nothing to submit. */
export interface PreparedTurn {
	session: ChannelSession;
	input: ChannelInput;
	onEvent?: (event: AgentSessionEvent) => void;
	finish(result: PromptResult | undefined, options: { resumeInMs?: number }): Promise<void>;
}

/** `resume` is true for the Auto-Resume turn, which re-runs the failed turn's own `prepare`. */
export type PrepareTurn = (signal: AbortSignal, resume: boolean) => Promise<PreparedTurn | undefined>;

export type StopDecision =
	| { kind: "cancelledResume" }
	| { kind: "halted"; runningTool?: string; skippedQueued: boolean }
	| { kind: "skippedQueued" }
	| { kind: "idle" };

export interface TurnQueueOptions {
	onBusy(chat: string): void;
	onIdle(chat: string): void;
	/** Delay before a turn that ended on a provider error gets its one Auto-Resume. */
	resumeDelayMs: number;
}

interface Turn {
	prepare: PrepareTurn;
	resume: boolean;
	abort: AbortController;
	/** Set once the turn is submitted; cleared when it starts finishing. */
	session?: ChannelSession;
	stoppable: boolean;
}

interface ChatTurns {
	queued: Turn[];
	current?: Turn;
}

export function createTurnQueue(options: TurnQueueOptions) {
	const chats = new Map<string, ChatTurns>();
	const pendingResumes = new Map<string, ReturnType<typeof setTimeout>>();

	function cancelResume(chat: string): boolean {
		const pending = pendingResumes.get(chat);
		if (!pending) return false;
		clearTimeout(pending);
		pendingResumes.delete(chat);
		return true;
	}

	function enqueue(chat: string, prepare: PrepareTurn, resume: boolean): void {
		let turns = chats.get(chat);
		if (!turns) {
			turns = { queued: [] };
			chats.set(chat, turns);
			options.onBusy(chat);
		}
		turns.queued.push({ prepare, resume, abort: new AbortController(), stoppable: true });
		if (!turns.current) void drain(chat, turns);
	}

	function idleIfDone(chat: string, turns: ChatTurns): void {
		if (turns.current || turns.queued.length > 0) return;
		chats.delete(chat);
		options.onIdle(chat);
	}

	async function drain(chat: string, turns: ChatTurns): Promise<void> {
		for (let turn = turns.queued.shift(); turn; turn = turns.queued.shift()) {
			turns.current = turn;
			try {
				await run(chat, turn);
			} catch (error) {
				console.error("Telegram turn failed:", error instanceof Error ? error.message : error);
			}
			turns.current = undefined;
		}
		idleIfDone(chat, turns);
	}

	async function run(chat: string, turn: Turn): Promise<void> {
		const prepared = await turn.prepare(turn.abort.signal, turn.resume);
		if (!prepared || turn.abort.signal.aborted) return;
		turn.session = prepared.session;
		const result = await prepared.session.submit(prepared.input, prepared.onEvent);
		turn.session = undefined;
		turn.stoppable = false;
		// Capped at one: a resume that fails again is reported and left for the owner.
		const resumeInMs = result?.finalError !== undefined && !turn.resume ? options.resumeDelayMs : undefined;
		await prepared.finish(result, { resumeInMs });
		if (resumeInMs === undefined) return;
		cancelResume(chat);
		pendingResumes.set(
			chat,
			setTimeout(() => {
				pendingResumes.delete(chat);
				enqueue(chat, turn.prepare, true);
			}, resumeInMs),
		);
	}

	return {
		/** Queue a turn for `chat` after any earlier one. Supersedes a pending Auto-Resume. */
		submit(chat: string, prepare: PrepareTurn): void {
			cancelResume(chat);
			enqueue(chat, prepare, false);
		},

		/**
		 * Cancel a pending Auto-Resume; otherwise halt the preparing or running turn, and skip the next
		 * queued one. Marked before the abort, which would otherwise let that queued turn start.
		 */
		async stop(chat: string): Promise<StopDecision> {
			if (cancelResume(chat)) return { kind: "cancelledResume" };
			const turns = chats.get(chat);
			if (!turns) return { kind: "idle" };
			const skippedQueued = turns.queued.shift() !== undefined;
			const current = turns.current?.stoppable ? turns.current : undefined;
			if (current) {
				current.abort.abort();
				const runningTool = current.session ? (await current.session.stop()).runningTool : undefined;
				return { kind: "halted", runningTool, skippedQueued };
			}
			idleIfDone(chat, turns);
			return skippedQueued ? { kind: "skippedQueued" } : { kind: "idle" };
		},
	};
}

export type TurnQueue = ReturnType<typeof createTurnQueue>;
