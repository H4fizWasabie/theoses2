import type { AgentMessage } from "theoses-agent-core";
import type { AgentSessionEvent } from "../agent-session.ts";
import { formatNoModelSelectedMessage } from "../auth-guidance.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../extensions/index.ts";
import type { MemoryPromotion } from "../memory-promotion.ts";
import type { CompactionEntry, SessionManager } from "../session-manager.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	estimateTokens,
	prepareCompaction,
} from "./compaction.ts";

/**
 * Compaction Run (CONTEXT.md): one execution of context compaction from preparation to `compaction_end`,
 * for the manual and the automatic triggers alike. It owns the extension hooks, the summarizer call, the
 * compaction entry, the message rebuild and every `compaction_end` / `session_compact_failed` pair. The
 * trigger decision and overflow-retry bookkeeping stay with the caller.
 */

export type CompactionReason = "manual" | "threshold" | "overflow" | "turns";

/** Produces the summary for a prepared compaction. The one seam: the built-in model call in production. */
export type Summarizer = (
	preparation: CompactionPreparation,
	options: { customInstructions: string | undefined; signal: AbortSignal; reason: CompactionReason },
) => Promise<CompactionResult>;

export type CompactionRunEvent = Extract<AgentSessionEvent, { type: "compaction_start" | "compaction_end" }>;

export interface CompactionRunOptions {
	sessionManager: SessionManager;
	/** Read per use: an extension reload swaps the runner while a session lives. */
	getExtensionRunner: () => ExtensionRunner;
	memoryPromotion: MemoryPromotion;
	getCompactionSettings: () => CompactionSettings;
	setMessages: (messages: AgentMessage[]) => void;
	emit: (event: CompactionRunEvent) => void;
	/** Resolves the summarizer up front (model and auth), or `undefined` when no model is selected. */
	prepareSummarizer: () => Promise<Summarizer | undefined>;
}

export interface CompactionRunRequest {
	reason: CompactionReason;
	/** Overflow recovery: the caller continues the interrupted turn after a completed run. */
	willRetry?: boolean;
	customInstructions?: string;
}

export type CompactionRunOutcome =
	| { kind: "completed"; result: CompactionResult }
	/** A hook or `abort()` cancelled the run. */
	| { kind: "cancelled"; error: Error }
	| { kind: "failed"; error: unknown }
	/** Automatic runs only: no model, or nothing to compact. Nothing was emitted. */
	| { kind: "skipped" };

export interface CompactionRun {
	/** Reason of the run in flight, if any. */
	readonly activeReason: CompactionReason | undefined;
	/** Cancels the run in flight. */
	abort(): void;
	run(request: CompactionRunRequest): Promise<CompactionRunOutcome>;
	/** Reports a failure decided outside a run, so the event pair still comes from one place. */
	reportFailure(reason: CompactionReason, errorMessage: string): Promise<void>;
}

class CompactionCancelled extends Error {
	constructor() {
		super("Compaction cancelled");
	}
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function failureMessage(reason: CompactionReason, error: unknown): string {
	if (reason === "manual") {
		return `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	const message = error instanceof Error ? error.message : "compaction failed";
	return reason === "overflow" ? `Context overflow recovery failed: ${message}` : `Auto-compaction failed: ${message}`;
}

export function createCompactionRun(options: CompactionRunOptions): CompactionRun {
	let active: { reason: CompactionReason; controller: AbortController } | undefined;

	async function reportFailure(
		reason: CompactionReason,
		errorMessage: string | undefined,
		aborted = false,
		fromExtension = false,
	): Promise<void> {
		options.emit({ type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage });
		const runner = options.getExtensionRunner();
		if (runner.hasHandlers("session_compact_failed")) {
			await runner.emit({
				type: "session_compact_failed",
				reason,
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
		}
	}

	async function run(request: CompactionRunRequest): Promise<CompactionRunOutcome> {
		const { reason, customInstructions } = request;
		const willRetry = request.willRetry ?? false;
		const manual = reason === "manual";
		const controller = new AbortController();
		let started = false;
		let fromExtension = false;

		// Manual runs announce themselves before validating, so a failure to start is reported. Automatic
		// runs stay silent until there is something to compact.
		const begin = () => {
			active = { reason, controller };
			options.emit({ type: "compaction_start", reason });
			started = true;
		};

		try {
			if (manual) begin();

			const summarizer = await options.prepareSummarizer();
			if (!summarizer) {
				if (manual) throw new Error(formatNoModelSelectedMessage());
				return { kind: "skipped" };
			}

			const { sessionManager } = options;
			const pathEntries = sessionManager.getBranch();
			const preparation = prepareCompaction(
				pathEntries,
				options.getCompactionSettings(),
				reason === "turns" ? "turns" : "tokens",
			);
			if (!preparation) {
				if (!manual) return { kind: "skipped" };
				const lastEntry = pathEntries[pathEntries.length - 1];
				throw new Error(
					lastEntry?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)",
				);
			}
			if (!manual) begin();
			options.memoryPromotion.promoteDropped(preparation.messagesToSummarizeEntryIds);

			let extensionCompaction: CompactionResult | undefined;
			const hookRunner = options.getExtensionRunner();
			if (hookRunner.hasHandlers("session_before_compact")) {
				const hookResult = (await hookRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason,
					willRetry,
					signal: controller.signal,
				})) as SessionBeforeCompactResult | undefined;
				if (hookResult?.cancel) throw new CompactionCancelled();
				if (hookResult?.compaction) {
					extensionCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const { summary, firstKeptEntryId, tokensBefore, usage, details } =
				extensionCompaction ??
				(await summarizer(preparation, { customInstructions, signal: controller.signal, reason }));
			if (controller.signal.aborted) throw new CompactionCancelled();

			sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const sessionContext = sessionManager.buildSessionContext();
			options.setMessages(sessionContext.messages);
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			const savedCompactionEntry = sessionManager
				.getEntries()
				.find((e) => e.type === "compaction" && e.summary === summary) as CompactionEntry | undefined;
			if (savedCompactionEntry) {
				await options.getExtensionRunner().emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			active = undefined;
			options.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			return { kind: "completed", result };
		} catch (error) {
			if (!started) return { kind: "failed", error };
			const cancelled =
				error instanceof CompactionCancelled || (manual && error instanceof Error && error.name === "AbortError");
			active = undefined;
			await reportFailure(reason, cancelled ? undefined : failureMessage(reason, error), cancelled, fromExtension);
			return cancelled
				? { kind: "cancelled", error: error instanceof Error ? error : new CompactionCancelled() }
				: { kind: "failed", error };
		} finally {
			active = undefined;
		}
	}

	return {
		get activeReason() {
			return active?.reason;
		},
		abort() {
			active?.controller.abort();
		},
		run,
		reportFailure: (reason, errorMessage) => reportFailure(reason, errorMessage),
	};
}
