// Offline score of recorded session logs: per model per day, how many replies were made, how many Claims they stated,
// how many of those were Grounded (shown by a tool result of the same Task), and the daily prompt-cache ratio from
// eval.db. Claim reading is the coding agent's own (claim-reading.ts), so this scores replies exactly as the stop-time
// checker will. No model is called.
//
// The headline counts specific Claims only (3+ digits, decimals, paths, URLs). Small integers (1-2 digits) turn up by
// coincidence in long tool output ("15" in "Oct 15 23:43"), so they are counted apart and reported as untrusted.
//
// Cited mode (#585): a Claim followed by a ⟨tN⟩ Citation is checked against output tN. It counts in the totals as before
// (Grounded if shown), a mismatch is a Contradiction (counted apart, never a Guess), and the "cited grounded" column
// is its share of cited Claims. Logs from before Citations shipped have none, so their rows are unchanged.
//
// A Task runs from one `task_boundary` entry to the next (its `beforeEntryId` is the first entry of the new Task). Only
// the Task's messages up to a reply can ground it, so a result from an earlier Task or a later one never counts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "theoses-agent-core";
import { type AssistantMessage, contentText } from "theoses-ai";
import { type Claim, readClaims } from "theoses-coding-agent";

/** One JSONL line of a session log. Only the fields this reader uses are typed. */
export interface SessionLine {
	type?: string;
	id?: string;
	timestamp?: string;
	message?: AgentMessage;
	customType?: string;
	data?: { beforeEntryId?: string };
}

export interface ReplyScore {
	model: string;
	day: string;
	claims: Claim[];
}

export interface DayRow {
	model: string;
	day: string;
	replies: number;
	/** Specific Claims only. */
	claims: number;
	grounded: number;
	guesses: number;
	/** Small Claims (1-2 digit integers), grounded or not. Untrusted, excluded from the three counts above. */
	small: number;
	/** Specific Claims with a Citation to an output of the Task (#585), a subset of `claims`. */
	cited: number;
	/** Cited Claims that the output shows, a subset of `grounded`. Cited share = citedGrounded / cited. */
	citedGrounded: number;
	/** Cited Claims that the output does not show, a subset of `claims`. Not counted as Guesses. */
	contradictions: number;
}

export interface SessionCorpus {
	/** Logical sessions, each the entries of its files in order with duplicates removed. */
	sessions: SessionLine[][];
	files: number;
	entries: number;
	duplicates: number;
}

export function jsonlFiles(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...jsonlFiles(path));
		else if (name.endsWith(".jsonl")) found.push(path);
	}
	return found.sort();
}

function parseLines(text: string): SessionLine[] {
	const lines: SessionLine[] = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		try {
			lines.push(JSON.parse(raw) as SessionLine);
		} catch {
			// A torn last line from a crash is not an entry.
		}
	}
	return lines;
}

/**
 * Rotation and archive copies repeat entries across files. Files are grouped by their session header id, ordered by
 * header time, and each entry id is kept once. A file with no header is its own session.
 */
export function dedupeFiles(files: { path: string; text: string }[]): SessionCorpus {
	const groups = new Map<string, { header: string; lines: SessionLine[] }[]>();
	let entries = 0;
	for (const file of files) {
		const lines = parseLines(file.text);
		entries += lines.length;
		const header = lines.find((line) => line.type === "session");
		const key = header?.id ?? file.path;
		const group = groups.get(key) ?? [];
		group.push({ header: header?.timestamp ?? "", lines });
		groups.set(key, group);
	}
	const sessions: SessionLine[][] = [];
	let kept = 0;
	for (const group of groups.values()) {
		const seen = new Set<string>();
		const merged: SessionLine[] = [];
		for (const part of group.sort((a, b) => a.header.localeCompare(b.header))) {
			for (const line of part.lines) {
				if (line.id !== undefined) {
					if (seen.has(line.id)) continue;
					seen.add(line.id);
				}
				merged.push(line);
				kept++;
			}
		}
		sessions.push(merged);
	}
	return { sessions, files: files.length, entries, duplicates: entries - kept };
}

export function loadCorpus(dir: string): SessionCorpus {
	return dedupeFiles(jsonlFiles(dir).map((path) => ({ path, text: readFileSync(path, "utf8") })));
}

/** A reply is an assistant message whose text is delivered: text, no tool calls. */
function isReply(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	const hasTool = message.content.some((c) => c.type === "toolCall");
	return !hasTool && contentText(message.content).trim() !== "";
}

/** Scores every reply of one logical session, in order. */
export function scoreSession(entries: SessionLine[]): ReplyScore[] {
	const starts = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "task_boundary" && entry.data?.beforeEntryId) {
			starts.add(entry.data.beforeEntryId);
		}
	}
	const scores: ReplyScore[] = [];
	let task: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.id !== undefined && starts.has(entry.id)) task = [];
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (isReply(message)) {
			const owner = task
				.filter((m) => m.role === "user")
				.map((m) => contentText(m.content))
				.join("\n");
			scores.push({
				model: message.model,
				day: (entry.timestamp ?? "").slice(0, 10),
				claims: readClaims(task, message, owner),
			});
		}
		task.push(message);
	}
	return scores;
}

/** Sums replies and Claims per model per day, inside the optional inclusive day range. Sorted by model, then day. */
export function aggregate(scores: ReplyScore[], range: { from?: string; to?: string } = {}): DayRow[] {
	const rows = new Map<string, DayRow>();
	for (const score of scores) {
		if (range.from && score.day < range.from) continue;
		if (range.to && score.day > range.to) continue;
		const key = `${score.model}\u0000${score.day}`;
		const row = rows.get(key) ?? {
			model: score.model,
			day: score.day,
			replies: 0,
			claims: 0,
			grounded: 0,
			guesses: 0,
			small: 0,
			cited: 0,
			citedGrounded: 0,
			contradictions: 0,
		};
		const specific = score.claims.filter((c) => c.specificity === "specific");
		row.replies++;
		row.claims += specific.length;
		row.grounded += specific.filter((c) => c.status === "grounded").length;
		row.guesses += specific.filter((c) => c.status === "guess").length;
		row.small += score.claims.length - specific.length;
		const cited = specific.filter((c) => c.cited !== undefined);
		row.cited += cited.length;
		row.citedGrounded += cited.filter((c) => c.status === "grounded").length;
		row.contradictions += specific.filter((c) => c.status === "contradiction").length;
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => a.model.localeCompare(b.model) || a.day.localeCompare(b.day));
}

/** Cache reads as a share of all input tokens, per model per day, from eval.db's `assistant_msgs`. */
export function cacheRatios(dbPath: string): Map<string, number> {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT model, substr(ts, 1, 10) AS day,
					COALESCE(SUM(cache_read), 0) AS cached, COALESCE(SUM(input_tokens), 0) AS input
				 FROM assistant_msgs GROUP BY model, day`,
			)
			.all() as { model: string; day: string; cached: number; input: number }[];
		const ratios = new Map<string, number>();
		for (const row of rows) {
			const total = row.input + row.cached;
			if (total > 0) ratios.set(`${row.model}\u0000${row.day}`, row.cached / total);
		}
		return ratios;
	} finally {
		db.close();
	}
}

const percent = (part: number, whole: number): string => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`);

/** Fixed-width table: one row per model per day, then a total row per model. */
export function formatTable(rows: DayRow[], cache?: Map<string, number>): string {
	const header = [
		"model",
		"day",
		"replies",
		"specific",
		"grounded",
		"guesses",
		"small (untrusted)",
		"cited grounded",
		"contradictions",
		"cache",
	];
	const body: string[][] = [];
	const models = [...new Set(rows.map((r) => r.model))];
	for (const model of models) {
		const own = rows.filter((r) => r.model === model);
		for (const row of own) {
			const ratio = cache?.get(`${row.model}\u0000${row.day}`);
			body.push([
				row.model,
				row.day,
				String(row.replies),
				String(row.claims),
				percent(row.grounded, row.claims),
				String(row.guesses),
				String(row.small),
				percent(row.citedGrounded, row.cited),
				String(row.contradictions),
				ratio === undefined ? "-" : `${(100 * ratio).toFixed(1)}%`,
			]);
		}
		const total = own.reduce(
			(sum, r) => ({
				replies: sum.replies + r.replies,
				claims: sum.claims + r.claims,
				grounded: sum.grounded + r.grounded,
				guesses: sum.guesses + r.guesses,
				small: sum.small + r.small,
				cited: sum.cited + r.cited,
				citedGrounded: sum.citedGrounded + r.citedGrounded,
				contradictions: sum.contradictions + r.contradictions,
			}),
			{ replies: 0, claims: 0, grounded: 0, guesses: 0, small: 0, cited: 0, citedGrounded: 0, contradictions: 0 },
		);
		body.push([
			model,
			"total",
			String(total.replies),
			String(total.claims),
			percent(total.grounded, total.claims),
			String(total.guesses),
			String(total.small),
			percent(total.citedGrounded, total.cited),
			String(total.contradictions),
			"",
		]);
	}
	const widths = header.map((_, i) => Math.max(header[i].length, ...body.map((row) => row[i].length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i]))
			.join("  ")
			.trimEnd();
	return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}
