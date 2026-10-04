/**
 * File checkpoints: before a tool call changes a file, its original bytes are saved once per user turn, so
 * the files can be put back to how they were before any earlier turn (`/rewind`, AgentSession.rewindFiles).
 *
 * Original bytes go to `<session dir>/checkpoints/<sha256>` (content-addressed, so an unchanged file costs
 * nothing twice, and shared by the sessions in that directory so a fork or clone still finds them); a
 * `file_checkpoint` custom entry in the session log records which path and hash belong to which turn.
 * Nothing lives in memory, so checkpoints survive a restart and follow the session's branches. They are the one
 * record of file history: rewinds (`rewindPoints`, `planFileRewind`) and the Task Plan review diff
 * (`originalsSince`) both read them.
 *
 * Covers what `fileChangesOf` can see: `edit`, `write`, and shell commands whose targets can be read off
 * (redirects, sed -i, cp, mv, rm, tee). A command that changes files in a way that cannot be traced (a
 * script that writes files) is recorded as untraced and cannot be undone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripClockAnnotation } from "./clock.ts";
import type { SessionEntry } from "./session-manager.ts";
import { fileChangesOf } from "./tool-runs.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export const FILE_CHECKPOINT_ENTRY_TYPE = "file_checkpoint";
/** Files bigger than this are not saved; a rewind reports them as not restorable. */
export const MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;
/** Original bytes not used by any checkpoint for this long are deleted (`sweepCheckpoints`). */
export const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface FileCheckpoint {
	/** Id of the user message the change ran under. */
	turnId: string;
	/** Absolute path. */
	path: string;
	/** sha256 of the original bytes; null when the file did not exist. Absent when the original was not saved. */
	hash?: string | null;
	/** Why the original was not saved (too large, not a regular file). */
	skipped?: string;
	/** A shell command that changes files in a way whose targets cannot be read off it. */
	untraced?: string;
}

/** The part of SessionManager the checkpoints use. */
export interface CheckpointSession {
	isPersisted(): boolean;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getCheckpointDirectory(): string;
	appendCustomEntry(customType: string, data?: unknown): string;
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function checkpointOf(entry: SessionEntry): FileCheckpoint | undefined {
	return entry.type === "custom" && entry.customType === FILE_CHECKPOINT_ENTRY_TYPE
		? (entry.data as FileCheckpoint)
		: undefined;
}

export class FileCheckpoints {
	private readonly session: CheckpointSession;
	private readonly cwd: string;

	constructor(session: CheckpointSession, cwd: string) {
		this.session = session;
		this.cwd = cwd;
	}

	/** Saves the original of every file the call is about to change, once per user turn. Never blocks or throws. */
	beforeToolCall(toolName: string, args: Record<string, unknown>): void {
		if (!this.session.isPersisted()) return;
		try {
			const turn = this.currentTurn();
			if (!turn) return;
			const changes = fileChangesOf(toolName, args, this.cwd, [...turn.seen]);
			if (!changes) return;
			for (const path of changes.paths) {
				const absolute = resolveToCwd(path, this.cwd);
				if (turn.seen.has(absolute)) continue;
				turn.seen.add(absolute);
				this.record({ turnId: turn.turnId, path: absolute, ...this.saveOriginal(absolute) });
			}
			if (changes.untraced) this.record({ turnId: turn.turnId, path: "", untraced: changes.untraced });
		} catch (error) {
			console.error(`[file-checkpoints] could not checkpoint ${toolName}: ${(error as Error).message}`);
		}
	}

	private record(checkpoint: FileCheckpoint): void {
		this.session.appendCustomEntry(FILE_CHECKPOINT_ENTRY_TYPE, checkpoint);
	}

	/** The user message the leaf's turn started with, and the paths already checkpointed since it. */
	private currentTurn(): { turnId: string; seen: Set<string> } | undefined {
		const seen = new Set<string>();
		for (
			let entry = this.session.getLeafEntry();
			entry;
			entry = entry.parentId ? this.session.getEntry(entry.parentId) : undefined
		) {
			if (entry.type === "message" && entry.message.role === "user") return { turnId: entry.id, seen };
			const checkpoint = checkpointOf(entry);
			if (checkpoint?.path) seen.add(checkpoint.path);
		}
		return undefined;
	}

	private saveOriginal(absolute: string): Pick<FileCheckpoint, "hash" | "skipped"> {
		let size: number;
		try {
			const stat = statSync(absolute);
			if (!stat.isFile()) return { skipped: "not a regular file" };
			size = stat.size;
		} catch (error) {
			if (isMissing(error)) return { hash: null };
			return { skipped: (error as Error).message };
		}
		if (size > MAX_CHECKPOINT_BYTES) return { skipped: `larger than ${MAX_CHECKPOINT_BYTES} bytes` };
		const bytes = readFileSync(absolute);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const blob = join(this.session.getCheckpointDirectory(), hash);
		if (existsSync(blob)) {
			// Reusing a blob counts as using it, so the sweep keeps it for as long as a recent checkpoint names it.
			const now = new Date();
			utimesSync(blob, now, now);
		} else {
			writeFileSync(blob, bytes, { mode: 0o600 });
		}
		return { hash };
	}
}

/**
 * Deletes original bytes in `directory` that no checkpoint has written or reused in `maxAgeMs`, so the directory
 * does not grow without bound. A rewind past that point reports those files as not restorable. Only files named
 * like a blob (a sha256) are touched. Returns how many were deleted. Never throws.
 */
export function sweepCheckpoints(
	directory: string,
	maxAgeMs: number = CHECKPOINT_RETENTION_MS,
	now: number = Date.now(),
): number {
	let removed = 0;
	try {
		for (const name of readdirSync(directory)) {
			if (!/^[0-9a-f]{64}$/.test(name)) continue;
			const blob = join(directory, name);
			if (now - statSync(blob).mtimeMs <= maxAgeMs) continue;
			rmSync(blob, { force: true });
			removed++;
		}
	} catch (error) {
		if (!isMissing(error)) console.error(`[file-checkpoints] sweep failed: ${(error as Error).message}`);
	}
	return removed;
}

export interface RewindPlan {
	/** Files to put back: `hash` is the content to restore, or null to delete a file that did not exist. */
	restore: Array<{ path: string; hash: string | null }>;
	/** Files whose original was not saved, so they cannot be restored. */
	skipped: Array<{ path: string; reason: string }>;
	/** Shell commands since then whose file changes could not be traced. */
	untraced: string[];
}

/**
 * What putting the files back to their state before `targetEntryId` (a user message) would do. The earliest
 * checkpoint of each path since then is the state before that turn. `branch` is the session's root-to-leaf path.
 */
export function planFileRewind(branch: SessionEntry[], targetEntryId: string): RewindPlan {
	const start = branch.findIndex((entry) => entry.id === targetEntryId);
	if (start < 0) throw new Error(`Entry ${targetEntryId} is not on the current branch`);
	const plan: RewindPlan = { restore: [], skipped: [], untraced: [] };
	const seen = new Set<string>();
	for (const entry of branch.slice(start)) {
		const checkpoint = checkpointOf(entry);
		if (!checkpoint) continue;
		if (checkpoint.untraced) {
			if (!plan.untraced.includes(checkpoint.untraced)) plan.untraced.push(checkpoint.untraced);
			continue;
		}
		if (seen.has(checkpoint.path)) continue;
		seen.add(checkpoint.path);
		if (checkpoint.hash === undefined) {
			plan.skipped.push({ path: checkpoint.path, reason: checkpoint.skipped ?? "original not saved" });
		} else {
			plan.restore.push({ path: checkpoint.path, hash: checkpoint.hash });
		}
	}
	return plan;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A user turn on the current branch that changed files: a point a rewind can go back to. */
export interface RewindPoint {
	entryId: string;
	text: string;
}

function userText(content: string | Array<{ type: string; text?: string }>): string {
	const text =
		typeof content === "string"
			? content
			: content.map((part) => (part.type === "text" ? (part.text ?? "") : "[image]")).join(" ");
	return stripClockAnnotation(text);
}

/** The user turns on `branch` (root to leaf) that changed files, newest first. Turns that changed nothing have nothing to rewind. */
export function rewindPoints(branch: SessionEntry[], limit = Number.POSITIVE_INFINITY): RewindPoint[] {
	const points: RewindPoint[] = [];
	let turnChangedFiles = false;
	for (let i = branch.length - 1; i >= 0 && points.length < limit; i--) {
		const entry = branch[i];
		if (checkpointOf(entry)) {
			turnChangedFiles = true;
		} else if (entry.type === "message" && entry.message.role === "user") {
			if (turnChangedFiles) points.push({ entryId: entry.id, text: userText(entry.message.content) });
			turnChangedFiles = false;
		}
	}
	return points;
}

/** The files changed since a point in time, each with its content from before: a Task Plan diff's "before" side. */
export interface Originals {
	/** `before` is null when the file did not exist. */
	files: Array<{ path: string; before: string | null }>;
	/** Files whose original was not saved (too large, not a regular file, or swept). */
	skipped: Array<{ path: string; reason: string }>;
	/** Shell commands whose file changes could not be traced. */
	untraced: string[];
}

/**
 * What the files changed since `since` (an ISO time) looked like before, from the checkpoints of the turn that was
 * running then and every turn after it. The earliest checkpoint per path wins, as for a rewind, so changes made
 * earlier in that turn are included. Persisted sessions only: a session that saves no checkpoints has no originals.
 */
export function originalsSince(branch: SessionEntry[], checkpointDirectory: string, since: string): Originals {
	const sinceMs = new Date(since).getTime();
	let turn: SessionEntry | undefined;
	for (const entry of branch) {
		if (new Date(entry.timestamp).getTime() > sinceMs) break;
		if (entry.type === "message" && entry.message.role === "user") turn = entry;
	}
	const originals: Originals = { files: [], skipped: [], untraced: [] };
	if (!turn) return originals;
	const plan = planFileRewind(branch, turn.id);
	originals.skipped.push(...plan.skipped);
	originals.untraced.push(...plan.untraced);
	for (const { path, hash } of plan.restore) {
		if (hash === null) {
			originals.files.push({ path, before: null });
			continue;
		}
		try {
			originals.files.push({ path, before: readFileSync(join(checkpointDirectory, hash), "utf8") });
		} catch (error) {
			if (!isMissing(error)) throw error;
			originals.skipped.push({ path, reason: "the original is no longer saved (older than 30 days)" });
		}
	}
	return originals;
}

/** Plain-text summary of what a rewind would do, for a confirmation prompt. */
export function describeRewindPlan(plan: RewindPlan): string {
	const lines: string[] = [];
	const deletions = plan.restore.filter((r) => r.hash === null).length;
	const restores = plan.restore.length - deletions;
	if (restores > 0) lines.push(`Restore ${count(restores, "file")} to how they were before.`);
	if (deletions > 0) lines.push(`Delete ${count(deletions, "file")} created since then.`);
	if (plan.skipped.length > 0) {
		const names = plan.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`);
		const more = plan.skipped.length > 3 ? `, and ${plan.skipped.length - 3} more` : "";
		lines.push(`Cannot restore ${count(plan.skipped.length, "file")}: ${names.join(", ")}${more}.`);
	}
	if (plan.untraced.length > 0) {
		lines.push(`${count(plan.untraced.length, "shell command")} changed files in ways that cannot be undone.`);
	}
	return lines.length > 0 ? lines.join("\n") : "No files changed since that message.";
}

export interface RewindResult extends Omit<RewindPlan, "restore"> {
	restored: string[];
	deleted: string[];
	failed: Array<{ path: string; error: string }>;
}

/** Puts the files of a plan back. One file failing does not stop the others. */
export function applyFileRewind(plan: RewindPlan, checkpointDirectory: string): RewindResult {
	const result: RewindResult = {
		restored: [],
		deleted: [],
		failed: [],
		skipped: plan.skipped,
		untraced: plan.untraced,
	};
	for (const { path, hash } of plan.restore) {
		try {
			if (hash === null) {
				if (existsSync(path)) {
					rmSync(path, { force: true });
					result.deleted.push(path);
				}
				continue;
			}
			let bytes: Buffer;
			try {
				bytes = readFileSync(join(checkpointDirectory, hash));
			} catch (error) {
				if (isMissing(error)) throw new Error("the original is no longer saved (older than 30 days)");
				throw error;
			}
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, bytes);
			result.restored.push(path);
		} catch (error) {
			result.failed.push({ path, error: (error as Error).message });
		}
	}
	return result;
}

/** Plain-text summary of what a rewind did, for the reply after it ran. */
export function describeRewindResult(result: RewindResult): string {
	const lines: string[] = [];
	if (result.restored.length > 0) lines.push(`Restored ${count(result.restored.length, "file")}.`);
	if (result.deleted.length > 0) lines.push(`Deleted ${count(result.deleted.length, "file")}.`);
	for (const { path, error } of result.failed) lines.push(`Could not restore ${path}: ${error}.`);
	if (result.skipped.length > 0) {
		lines.push(`Not restorable: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}.`);
	}
	if (result.untraced.length > 0) {
		lines.push(`${count(result.untraced.length, "shell command")} changed files in ways that cannot be undone.`);
	}
	return lines.length > 0 ? lines.join("\n") : "No files changed since that message.";
}
