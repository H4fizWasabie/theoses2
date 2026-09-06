import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../config.ts";
import { QUERY_STOPWORDS } from "./memory-store.ts";

export interface EpisodeRecord {
	id: string;
	/** Range, not a point — a consolidation window spans real wall-clock time. */
	startedAt: string;
	endedAt: string;
	summary: string;
	createdAt: string;
	/** Lightweight cross-reference into the semantic `.md` graph's node ids — no edge machinery here. */
	relatedSemanticNodeIds: string[];
}

interface EpisodeRow {
	id: string;
	started_at: string;
	ended_at: string;
	summary: string;
	created_at: string;
	related_semantic_node_ids: string;
}

function defaultEpisodicDbPath(): string {
	// Derived from getAgentDir() (respects THEOSES_CODING_AGENT_DIR) rather than a bare homedir()
	// call, so deployments that pin the agent dir to a stable path don't silently land the
	// episodic store in the wrong user's home directory. Same fix as memory-store.ts's
	// getMemoriesDir() and the THEOSES_TELEGRAM_CWD fix for session-manager.ts.
	return process.env.THEOSES_EPISODIC_DB ?? join(dirname(getAgentDir()), "episodes.db");
}

function rowToRecord(row: EpisodeRow): EpisodeRecord {
	let relatedSemanticNodeIds: string[] = [];
	try {
		relatedSemanticNodeIds = JSON.parse(row.related_semantic_node_ids) as string[];
	} catch {
		relatedSemanticNodeIds = [];
	}
	return {
		id: row.id,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		summary: row.summary,
		createdAt: row.created_at,
		relatedSemanticNodeIds,
	};
}

export class EpisodicStore {
	private readonly db: DatabaseSync;

	private constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * node:sqlite is a Node-only experimental module that Bun's compiled binaries cannot
	 * resolve. Importing it dynamically here (rather than as a static top-level import) means
	 * the module is only resolved when an EpisodicStore is actually created, not at binary
	 * startup - so a bun-compiled CLI that never touches episodic memory still runs.
	 */
	static async create(path = defaultEpisodicDbPath()): Promise<EpisodicStore> {
		const { DatabaseSync } = await import("node:sqlite");
		mkdirSync(dirname(path), { recursive: true });
		const db = new DatabaseSync(path);
		db.exec(`
			CREATE TABLE IF NOT EXISTS episodes (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at TEXT NOT NULL,
				related_semantic_node_ids TEXT NOT NULL DEFAULT '[]'
			);
			CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at);
			CREATE INDEX IF NOT EXISTS idx_episodes_ended_at ON episodes(ended_at);
		`);
		return new EpisodicStore(db);
	}

	/** Consolidation-only write path — there is no live/explicit path for episodic memory. */
	recordEpisode(input: {
		startedAt: string;
		endedAt: string;
		summary: string;
		relatedSemanticNodeIds?: string[];
	}): EpisodeRecord {
		const record: EpisodeRecord = {
			id: randomUUID(),
			startedAt: input.startedAt,
			endedAt: input.endedAt,
			summary: input.summary.trim(),
			createdAt: new Date().toISOString(),
			relatedSemanticNodeIds: input.relatedSemanticNodeIds ?? [],
		};
		this.db
			.prepare(
				"INSERT INTO episodes (id, started_at, ended_at, summary, created_at, related_semantic_node_ids) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				record.id,
				record.startedAt,
				record.endedAt,
				record.summary,
				record.createdAt,
				JSON.stringify(record.relatedSemanticNodeIds),
			);
		return record;
	}

	/** Keyword search over episode summaries, most recent first. */
	search(query: string, limit = 8): EpisodeRecord[] {
		const allTerms = query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((term) => term.length >= 3);
		const significantTerms = allTerms.filter((term) => !QUERY_STOPWORDS.has(term));
		const terms = significantTerms.length > 0 ? significantTerms : allTerms;
		if (terms.length === 0) return this.recent(limit);
		const rows = this.db.prepare("SELECT * FROM episodes ORDER BY started_at DESC").all() as unknown as EpisodeRow[];
		return rows
			.filter((row) => terms.some((term) => row.summary.toLowerCase().includes(term)))
			.slice(0, limit)
			.map(rowToRecord);
	}

	/**
	 * Point-in-time query: episodes whose [startedAt, endedAt] range contains `timestamp`,
	 * falling back to the episodes nearest that timestamp when none contain it exactly.
	 */
	atTime(timestamp: string, limit = 8): EpisodeRecord[] {
		const containing = this.db
			.prepare("SELECT * FROM episodes WHERE started_at <= ? AND ended_at >= ? ORDER BY started_at DESC LIMIT ?")
			.all(timestamp, timestamp, limit) as unknown as EpisodeRow[];
		if (containing.length > 0) return containing.map(rowToRecord);

		// Per-row distance, not an aggregate: MIN() with no GROUP BY would collapse the whole
		// table into a single row, silently ignoring `limit` and returning at most one episode.
		const nearest = this.db
			.prepare(
				`SELECT *, ABS(julianday(started_at) - julianday(?)) AS distance
				 FROM episodes ORDER BY distance ASC LIMIT ?`,
			)
			.all(timestamp, limit) as unknown as EpisodeRow[];
		return nearest.map(rowToRecord);
	}

	/** Pure chronological listing, most recent first. */
	recent(limit = 8): EpisodeRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?")
			.all(limit) as unknown as EpisodeRow[];
		return rows.map(rowToRecord);
	}

	close(): void {
		this.db.close();
	}
}
