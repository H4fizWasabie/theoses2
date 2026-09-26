import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { EpisodicStore } from "./episodic-store.ts";
import {
	CONSOLIDATION_TURN_CEILING,
	runConsolidationPass,
	shouldTriggerConsolidation,
} from "./memory-consolidation.ts";
import { FileMemoryStore } from "./memory-store.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, SessionMessageEntry } from "./session-manager.ts";
import { findLastUserMessageEntryId } from "./task-boundary-detector.ts";

/**
 * Memory Promotion: the ONLY way a turn reaches Durable Memory. Two triggers hand it entries: compaction
 * (`promoteDropped`, ADR-0001 — the trigger is compaction's own cut point, not a turn counter) and Turn
 * Settlement (`settle`, Jev-gated). Both run the same consolidation pipeline (background model, chunked at
 * CONSOLIDATION_TURN_CEILING, one promoted_range recorded per successful chunk) against whichever of their
 * entries no earlier pass already covered, so nothing is distilled twice. A model-invoked save (`recordSaved`)
 * marks its own turn promoted directly, without a model call.
 *
 * Single-flight and a failure cooldown are shared across both triggers for one Channel Session (ADR-0006: this
 * belongs to promotion, not to Turn Settlement, since compaction and settlement can otherwise overlap): a
 * promotion pass already running for this session's key makes the other trigger skip and leave its entries
 * unpromoted for the next attempt.
 */
export interface MemoryPromotion {
	/** Fire-and-forget. Compaction hands over the entries it is about to drop; only the ones no earlier pass
	 * promoted are distilled. Never throws — a failed pass is logged and left for Turn Settlement to retry. */
	promoteDropped(messageEntryIds: string[] | undefined): void;
	/** Fire-and-forget. The Jev-gated Turn Settlement path: runs over every entry no promoted range covers yet,
	 * if the trigger fires. Never throws. */
	settle(userMessageText: string): void;
	/** Call after the model saved a note: marks the current turn (last user message up to now) as promoted,
	 * no model call needed. */
	recordSaved(): void;
}

export interface CreateMemoryPromotionOptions {
	sessionManager: SessionManager;
	modelRuntime: ModelRuntime;
	memoryStore?: FileMemoryStore;
	episodicStore?: EpisodicStore;
}

/**
 * Issue #177: tracks channel-session keys with a promotion pass currently in flight, shared by both triggers.
 * Necessary because both `promoteDropped` and `settle` are fire-and-forget — without this, two overlapping
 * passes for the same session could each hold their own multi-hundred-K-token transcript in memory at once.
 */
const inFlightPromotions = new Set<string>();

/**
 * Issue #177: without a cooldown, a failing window never advances, so every subsequent trigger re-runs
 * promotion over an ever-growing window. A failure now blocks re-triggering (from either path) for this long.
 * ponytail: per process, so a restart allows one early retry; persist it if restarts ever cluster.
 */
const CONSOLIDATION_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const lastFailureAt = new Map<string, number>();

function channelSessionKey(channel: string, channelSessionId: string): string {
	return `${channel}:${channelSessionId}`;
}

/** The checkpoint file consolidation used before promoted_range records; read once per session to migrate. */
function legacyCheckpointPath(): string {
	return (
		process.env.THEOSES_CONSOLIDATION_CHECKPOINTS ?? join(dirname(getAgentDir()), "consolidation-checkpoints.json")
	);
}

/**
 * Moves one Channel Session's checkpoint from the legacy file into its session log as a promoted range, then
 * drops it from the file (and the file once empty), so a session consolidated before the upgrade does not
 * replay its history. A checkpoint id missing from the branch keeps the old rule: only the last chunk is read.
 */
function migrateLegacyCheckpoint(key: string, sessionManager: SessionManager): void {
	const path = legacyCheckpointPath();
	if (!existsSync(path)) return;
	let all: Record<string, { lastEntryId: string | null }>;
	try {
		all = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (!(key in all)) return;
	const lastEntryId = all[key]?.lastEntryId;
	const branch = sessionManager.getBranch();
	const messages = branch.filter((entry) => entry.type === "message");
	let last = lastEntryId ? branch.find((entry) => entry.id === lastEntryId) : undefined;
	if (lastEntryId && !last) last = messages[messages.length - CONSOLIDATION_TURN_CEILING - 1];
	if (branch[0] && last) sessionManager.appendPromotedRange(branch[0].id, last.id);
	delete all[key];
	if (Object.keys(all).length === 0) rmSync(path, { force: true });
	else writeFileSync(path, JSON.stringify(all, null, 2));
}

/**
 * Picks the messages Durable Memory has not seen yet: every message no promoted range covers, in one pass over
 * the branch. That skips what an earlier consolidation pass covered and turns the model already saved a note
 * from (save_note marks its turn promoted). A session nothing has promoted is read in full.
 */
export function selectConsolidationWindow(branch: SessionEntry[]): SessionMessageEntry[] {
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const promoted = new Array<boolean>(branch.length).fill(false);
	for (const entry of branch) {
		if (entry.type !== "promoted_range") continue;
		const first = positions.get(entry.firstEntryId);
		const last = positions.get(entry.lastEntryId);
		if (first === undefined || last === undefined) continue;
		for (let index = first; index <= last; index++) promoted[index] = true;
	}
	return branch.filter((entry, index): entry is SessionMessageEntry => entry.type === "message" && !promoted[index]);
}

export function createMemoryPromotion(options: CreateMemoryPromotionOptions): MemoryPromotion {
	const { sessionManager, modelRuntime } = options;
	const { channel, channelSessionId } = sessionManager.getChannelSessionKey();
	const key = channelSessionKey(channel, channelSessionId);

	/**
	 * Runs one promotion pass over `window` (already filtered to unpromoted entries), chunked at
	 * CONSOLIDATION_TURN_CEILING with one promoted_range recorded per successful chunk — so a later chunk's
	 * failure never rolls back progress already made. Shared by both triggers: single-flight and the failure
	 * cooldown apply regardless of which one called it.
	 */
	async function runPromotionPass(window: SessionMessageEntry[]): Promise<void> {
		if (window.length === 0) return;
		if (inFlightPromotions.has(key)) return; // A pass for this session is already running; entries stay unpromoted.
		inFlightPromotions.add(key);
		try {
			const failedAt = lastFailureAt.get(key);
			if (failedAt !== undefined && Date.now() - failedAt < CONSOLIDATION_FAILURE_COOLDOWN_MS) return;

			const memoryStore = options.memoryStore ?? new FileMemoryStore();
			const episodicStore = options.episodicStore ?? (await EpisodicStore.create());

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
					lastFailureAt.set(key, Date.now());
					throw error;
				}
				lastFailureAt.delete(key);
				const first = chunk[0];
				const last = chunk[chunk.length - 1];
				if (first && last) sessionManager.appendPromotedRange(first.id, last.id);
			}
		} finally {
			inFlightPromotions.delete(key);
		}
	}

	return {
		promoteDropped(messageEntryIds) {
			if (!messageEntryIds || messageEntryIds.length === 0) return;
			void (async () => {
				migrateLegacyCheckpoint(key, sessionManager);
				const branch = sessionManager.getBranch();
				const unpromotedIds = new Set(selectConsolidationWindow(branch).map((entry) => entry.id));
				const byId = new Map(
					branch
						.filter((entry): entry is SessionMessageEntry => entry.type === "message")
						.map((entry) => [entry.id, entry] as const),
				);
				const entries = messageEntryIds
					.filter((id) => unpromotedIds.has(id))
					.map((id) => byId.get(id))
					.filter((entry): entry is SessionMessageEntry => entry !== undefined);
				await runPromotionPass(entries);
			})().catch((error: unknown) => {
				console.error(
					`Memory promotion (compaction) failed for ${key}:`,
					error instanceof Error ? error.message : error,
				);
			});
		},
		settle(userMessageText) {
			void (async () => {
				migrateLegacyCheckpoint(key, sessionManager);
				const window = selectConsolidationWindow(sessionManager.getBranch());
				if (window.length === 0) return;
				if (!(await shouldTriggerConsolidation(userMessageText, window.length))) return;
				await runPromotionPass(window);
			})().catch((error: unknown) => {
				console.error(
					`Memory promotion (settlement) failed for ${key}:`,
					error instanceof Error ? error.message : error,
				);
			});
		},
		recordSaved() {
			const entries = sessionManager.getBranch();
			// The fact came from this turn's work, which the model saw but cannot attribute more precisely.
			// ponytail: a fact taken from an earlier turn is distilled again at the next promotion (a harmless duplicate).
			const first = findLastUserMessageEntryId(entries);
			const last = entries[entries.length - 1];
			if (first && last) sessionManager.appendPromotedRange(first, last.id);
		},
	};
}
