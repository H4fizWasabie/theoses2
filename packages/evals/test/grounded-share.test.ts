import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aggregate,
	cacheRatios,
	dedupeFiles,
	formatTable,
	loadCorpus,
	type SessionLine,
	scoreSession,
} from "../src/grounded-share.ts";

const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const line = (value: object) => JSON.stringify(value);

const session = [
	line({ type: "session", id: "s1", timestamp: at(0) }),
	line({
		type: "message",
		id: "u1",
		timestamp: at(1),
		message: { role: "user", content: "count the names", timestamp: 0 },
	}),
	line({
		type: "message",
		id: "a1",
		timestamp: at(2),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "wc -l names.txt" } }],
			model: "m1",
			timestamp: 0,
		},
	}),
	line({
		type: "message",
		id: "r1",
		timestamp: at(3),
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "150 names.txt" }],
			isError: false,
			timestamp: 0,
		},
	}),
	line({
		type: "message",
		id: "a2",
		timestamp: at(4),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "150 names are untracked." }],
			model: "m1",
			timestamp: 0,
		},
	}),
	line({ type: "custom", id: "tb1", customType: "task_boundary", data: { beforeEntryId: "u2" } }),
	line({
		type: "message",
		id: "u2",
		timestamp: at(5),
		message: { role: "user", content: "portfolio review", timestamp: 0 },
	}),
	line({
		type: "message",
		id: "a3",
		timestamp: at(6),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "130 are untracked." }],
			model: "m1",
			timestamp: 0,
		},
	}),
	line({
		type: "message",
		id: "a4",
		timestamp: at(7),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Still 150 names, in 15 dirs." }],
			model: "m1",
			timestamp: 0,
		},
	}),
];

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "grounded-share-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("grounded share", () => {
	it("dedupes a rotation copy by entry id", () => {
		mkdirSync(join(dir, "a"));
		mkdirSync(join(dir, "b"));
		writeFileSync(join(dir, "a", "one.jsonl"), session.join("\n"));
		writeFileSync(join(dir, "b", "copy.jsonl"), session.join("\n"));
		const corpus = loadCorpus(dir);
		expect(corpus.files).toBe(2);
		expect(corpus.sessions).toHaveLength(1);
		expect(corpus.duplicates).toBe(session.length);
	});

	it("tolerates a torn last line", () => {
		const corpus = dedupeFiles([{ path: "x", text: `${session.join("\n")}\n{"type":"mess` }]);
		expect(corpus.sessions[0]).toHaveLength(session.length);
	});

	it("grounds a reply only from tool results of its own Task", () => {
		const scores = scoreSession(session.map((text) => JSON.parse(text) as SessionLine));
		expect(scores.map((s) => s.claims.map((c) => `${c.value}:${c.status}:${c.specificity}`))).toEqual([
			["150:grounded:specific"], // first Task: wc showed 150
			["130:guess:specific"], // second Task: no tool output shows 130
			["150:guess:specific", "15:guess:small"], // second Task: 150 was only in the earlier Task
		]);
	});

	it("aggregates replies, Claims, Grounded share and Guesses per model per day", () => {
		const scores = scoreSession(session.map((text) => JSON.parse(text) as SessionLine));
		const rows = aggregate(scores);
		// The headline counts specific Claims only; the small "15" is counted apart.
		expect(rows).toEqual([
			{ model: "m1", day: "2026-10-17", replies: 3, claims: 3, grounded: 1, guesses: 2, small: 1 },
		]);
		expect(aggregate(scores, { to: "2026-10-16" })).toEqual([]);
	});

	it("reads the daily cache ratio from eval.db", () => {
		const path = join(dir, "eval.db");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE assistant_msgs (session_id TEXT, task_seq INTEGER, ts TEXT, model TEXT, stop_reason TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cost REAL, has_error INTEGER, provider TEXT)",
		);
		db.exec(
			"INSERT INTO assistant_msgs (ts, model, input_tokens, cache_read) VALUES ('2026-10-17T10:00:00Z', 'm1', 100, 300), ('2026-10-17T11:00:00Z', 'm1', 100, 100)",
		);
		db.close();
		expect(cacheRatios(path).get("m1\u00002026-10-17")).toBeCloseTo(400 / 600);
	});

	it("prints one row per model per day with a total row", () => {
		const scores = scoreSession(session.map((text) => JSON.parse(text) as SessionLine));
		const table = formatTable(aggregate(scores));
		expect(table).toContain("m1");
		expect(table).toContain("2026-10-17");
		expect(table).toContain("total");
		expect(table).toContain("small (untrusted)");
	});
});
