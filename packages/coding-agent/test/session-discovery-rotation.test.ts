import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "theoses-ai";
import { fauxAssistantMessage, registerFauxProvider } from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpisodicStore } from "../src/core/episodic-store.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { backfillFromSessionLog } from "../src/core/memory-consolidation.ts";
import { FileMemoryStore } from "../src/core/memory-store.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { findSessionById, sessionIdMatches } from "../src/core/session-discovery.ts";
import { findMostRecentSession, SessionManager } from "../src/core/session-manager.ts";

describe("session discovery after Log Rotation", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "theoses-discovery-rotation-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function chain() {
		const manager = SessionManager.create(root, root, { channel: "dashboard", channelSessionId: "owner" });
		manager.appendMessage({ role: "user", content: "history in A", timestamp: 1 });
		const a = manager.getSessionFile()!;
		const aId = manager.getSessionId();
		const b = manager.rotate()!;
		const bId = manager.getSessionId();
		manager.appendMessage({ role: "user", content: "history in B", timestamp: 2 });
		const c = manager.rotate()!;
		manager.appendSessionInfo("current name");
		manager.appendMessage({ role: "user", content: "history in C", timestamp: 3 });
		return { manager, a, aId, b, bId, c };
	}

	it("lists only the current log of a healthy chain, using its metadata", async () => {
		const { manager, a, b, c } = chain();
		const archived = [a, b].map((path) => readFileSync(path, "utf8"));
		const key = manager.getChannelSessionKey();
		for (const sessions of [
			await SessionManager.list(root, root, undefined, key),
			await SessionManager.listAll(root, undefined, "dashboard"),
		]) {
			expect(sessions.map((session) => session.path)).toEqual([c]);
			expect(sessions[0]).toMatchObject({ id: manager.getSessionId(), name: "current name", messageCount: 3 });
		}
		expect([a, b].map((path) => readFileSync(path, "utf8"))).toEqual(archived);
	});

	it("resumes old paths at the current log and appends there without changing predecessors", () => {
		const { a, b, c, manager } = chain();
		const archived = [a, b].map((path) => readFileSync(path, "utf8"));
		for (const path of [a, b]) {
			const resumed = SessionManager.open(path);
			expect(resumed.getSessionFile()).toBe(c);
			expect(resumed.getSessionId()).toBe(manager.getSessionId());
			expect(JSON.stringify(resumed.getEntries())).toContain("history in C");
			resumed.appendMessage({ role: "user", content: `resumed ${path}`, timestamp: 4 });
			expect(readFileSync(c, "utf8")).toContain(`resumed ${path}`);
		}
		expect([a, b].map((path) => readFileSync(path, "utf8"))).toEqual(archived);
		const switched = SessionManager.inMemory(root);
		switched.setSessionFile(a);
		expect(switched.getSessionFile()).toBe(c);
		utimesSync(a, new Date("2030-01-01"), new Date("2030-01-01"));
		expect(findMostRecentSession(root, undefined, manager.getChannelSessionKey())).toBe(c);
	});

	it("resolves an ID prefix shared by one chain's logs to its current log", async () => {
		const { manager, aId, bId, c } = chain();
		const prefix = aId.slice(0, 4);
		expect([bId, manager.getSessionId()].every((id) => id.startsWith(prefix))).toBe(true);
		expect((await findSessionById(prefix, { sessionDir: root, prefix: true }))?.path).toBe(c);
	});

	it("rejects an ID prefix shared by different sessions, but still resolves an exact ID", async () => {
		const twins = ["twin-1", "twin-2"].map((id) => {
			const manager = SessionManager.create(root, root, { id, channel: "dashboard", channelSessionId: id });
			manager.appendMessage({ role: "user", content: id, timestamp: 1 });
			return manager.getSessionFile();
		});
		await expect(findSessionById("twin", { sessionDir: root, prefix: true })).rejects.toThrow(/ambiguous/);
		expect((await findSessionById("twin-1", { sessionDir: root, prefix: true }))?.path).toBe(twins[0]);
	});

	it("treats an old ID behind a damaged rotation link as no match, not an error", () => {
		const { manager, aId, b, c } = chain();
		const lines = readFileSync(b, "utf8").trim().split("\n");
		lines[lines.length - 1] = JSON.stringify({
			...JSON.parse(lines[lines.length - 1]),
			data: { to: join(root, "gone.jsonl") },
		});
		writeFileSync(b, `${lines.join("\n")}\n`);
		expect(sessionIdMatches(aId, c)).toBe(false);
		expect(sessionIdMatches(manager.getSessionId(), c)).toBe(true);
	});

	it("refuses a stale handle's append after another handle closes its log by rotation", () => {
		const manager = SessionManager.create(root, root, { channel: "dashboard", channelSessionId: "owner" });
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const a = manager.getSessionFile()!;
		const stale = SessionManager.open(a);
		manager.rotate();
		const archived = readFileSync(a, "utf8");
		expect(() => stale.appendMessage({ role: "user", content: "stale write", timestamp: 2 })).toThrow(/closed/);
		expect(readFileSync(a, "utf8")).toBe(archived);
		expect(JSON.stringify(stale.getEntries())).not.toContain("stale write");
	});

	it.each(["missing", "empty", "invalid", "wrong parent", "wrong channel", "cycle"])(
		"keeps a %s chain visible but refuses resume without changing any file",
		async (damage) => {
			const { a, b, c } = chain();
			if (damage === "missing") rmSync(c);
			else if (damage === "empty") writeFileSync(c, "");
			else if (damage === "invalid") writeFileSync(c, '{"type":"message"}\n');
			else if (damage === "wrong parent" || damage === "wrong channel") {
				const lines = readFileSync(c, "utf8").trim().split("\n");
				lines[0] = JSON.stringify({
					...JSON.parse(lines[0]),
					...(damage === "wrong parent" ? { parentSession: a } : { channel: "telegram" }),
				});
				writeFileSync(c, `${lines.join("\n")}\n`);
			} else {
				const lines = readFileSync(a, "utf8").trim().split("\n");
				lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: c });
				writeFileSync(a, `${lines.join("\n")}\n`);
				appendFileSync(
					c,
					`${JSON.stringify({ type: "custom", customType: "session_rotated", data: { to: a } })}\n`,
				);
			}
			const before = [a, b, c].map((path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined));
			const unrelated = SessionManager.create(root, root, { channel: "dashboard", channelSessionId: "other" });
			unrelated.appendMessage({ role: "user", content: "unrelated", timestamp: 5 });
			expect(() => SessionManager.open(a)).toThrow(/Broken Log Rotation chain/);
			expect(() => SessionManager.open(b, root, root)).toThrow(/Broken Log Rotation chain/);
			expect([a, b, c].map((path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined))).toEqual(before);
			const listed = await SessionManager.listAll(root);
			expect(listed.map((info) => info.path)).toContain(a);
			expect(listed.map((info) => info.path)).toContain(unrelated.getSessionFile());
		},
	);

	it("reads an archived log exactly without writable repair or redirection, and forks it independently", () => {
		const { a, aId } = chain();
		const archived = readFileSync(a, "utf8");
		const read = SessionManager.read(a);
		expect(read.getSessionId()).toBe(aId);
		expect(JSON.stringify(read.getEntries())).toContain("history in A");
		expect(JSON.stringify(read.getEntries())).not.toContain("history in B");
		read.appendMessage({ role: "user", content: "in memory only", timestamp: 6 });
		expect(readFileSync(a, "utf8")).toBe(archived);
		const fork = SessionManager.forkFrom(a, root, root);
		expect(JSON.stringify(fork.getEntries())).not.toContain("history in B");
		expect(SessionManager.open(fork.getSessionFile()!).getSessionId()).toBe(fork.getSessionId());
		expect(readFileSync(a, "utf8")).toBe(archived);
	});

	it("branches at an archived entry without switching to its successor", () => {
		const { a } = chain();
		const archived = readFileSync(a, "utf8");
		const source = SessionManager.read(a);
		const entry = source.getEntries().find((entry) => entry.type === "message")!;
		const forkPath = source.createBranchedSession(entry.id, root)!;
		source.appendMessage(fauxAssistantMessage("fork reply"));
		expect(source.getHeader()?.parentSession).toBe(a);
		expect(SessionManager.open(forkPath).getSessionId()).toBe(source.getSessionId());
		expect(JSON.stringify(source.getEntries())).not.toContain("history in B");
		expect(readFileSync(a, "utf8")).toBe(archived);
	});

	it("branches at an archive's final record without inheriting its closing marker", () => {
		const manager = SessionManager.create(root, root, { channel: "dashboard", channelSessionId: "owner" });
		manager.appendMessage({ role: "user", content: "original turn", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("original reply"));
		const a = manager.getSessionFile()!;
		manager.rotate();
		const archived = readFileSync(a, "utf8");
		const snapshot = SessionManager.read(a);
		const forkPath = snapshot.createBranchedSession(snapshot.getLeafId()!, root)!;
		expect(SessionManager.open(forkPath).getSessionId()).toBe(snapshot.getSessionId());
		snapshot.appendMessage({ role: "user", content: "fork only", timestamp: 2 });
		expect(readFileSync(forkPath, "utf8")).toContain("fork only");
		expect(readFileSync(a, "utf8")).toBe(archived);
	});

	it.each(["stale handle", "archive snapshot"])(
		"preserves artifact bytes when a %s attempts to overwrite them",
		(kind) => {
			const manager = SessionManager.create(root, root, { channel: "dashboard", channelSessionId: "owner" });
			const artifactId = manager.storeArtifact("report", "report.pdf", Buffer.from("original bytes"));
			const artifact = manager.getEntry(artifactId);
			if (artifact?.type !== "artifact") throw new Error("Expected a stored artifact");
			const a = manager.getSessionFile()!;
			const stale = SessionManager.open(a);
			manager.rotate();
			const archived = readFileSync(a, "utf8");
			const writer = kind === "stale handle" ? stale : SessionManager.read(a);
			expect(() => writer.storeArtifact("report", "report.pdf", Buffer.from("replacement bytes"))).toThrow();
			expect(readFileSync(artifact.path, "utf8")).toBe("original bytes");
			expect(readFileSync(a, "utf8")).toBe(archived);
		},
	);

	it("exports the exact archive without repairing its source", async () => {
		const { a, aId } = chain();
		const archived = readFileSync(a, "utf8").trimEnd();
		writeFileSync(a, archived);
		const output = await exportFromFile(a, join(root, "archive.html"));
		const encoded = readFileSync(output, "utf8").match(
			/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
		)![1];
		const data = Buffer.from(encoded, "base64").toString("utf8");
		expect(JSON.parse(data).header.id).toBe(aId);
		expect(data).toContain("history in A");
		expect(data).not.toContain("history in B");
		expect(readFileSync(a, "utf8")).toBe(archived);
	});

	it("backfills the specified archive's messages rather than the current log", async () => {
		const { a } = chain();
		const archived = readFileSync(a, "utf8");
		const completeSimple = vi.fn(async (_model: Model<Api>, _context: Context) => fauxAssistantMessage("{}"));
		const faux = registerFauxProvider();
		const modelRuntime = { getModel: () => faux.getModel(), completeSimple } as unknown as ModelRuntime;
		const episodicStore = await EpisodicStore.create(join(root, "episodes.sqlite"));
		try {
			await backfillFromSessionLog(a, {
				cwd: root,
				modelRuntime,
				memoryStore: new FileMemoryStore(join(root, "memory")),
				episodicStore,
			});
			expect(completeSimple).toHaveBeenCalledTimes(1);
			const input = JSON.stringify(completeSimple.mock.calls[0][1]);
			expect(input).toContain("history in A");
			expect(input).not.toContain("history in B");
			expect(readFileSync(a, "utf8")).toBe(archived);
		} finally {
			episodicStore.close();
			faux.unregister();
		}
	});
});
