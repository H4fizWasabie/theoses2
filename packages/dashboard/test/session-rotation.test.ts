import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "theoses-coding-agent";
import { createDashboardServer } from "../src/index.ts";

test("dashboard lists the current log, resolves old IDs to current history, and reports broken chains", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-rotation-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const previousAgentDir = process.env.THEOSES_CODING_AGENT_DIR;
	process.env.THEOSES_CODING_AGENT_DIR = agentDir;
	const server = createDashboardServer({ accessToken: "fixture-owner", cwd: root });
	try {
		const manager = SessionManager.create(root, undefined, { channel: "dashboard", channelSessionId: "owner" });
		manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
		const a = manager.getSessionFile()!;
		const oldId = manager.getSessionId();
		manager.rotate();
		manager.rotate();
		manager.appendMessage({ role: "user", content: "current history", timestamp: 2 });
		const archived = await readFile(a, "utf8");
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const headers = { Authorization: "Bearer fixture-owner" };
		const listed = await fetch(`${base}/api/sessions`, { headers });
		const list = (await listed.json()) as { sessions: Array<{ id: string }> };
		assert.deepEqual(
			list.sessions.map((info) => info.id),
			[manager.getSessionId()],
		);
		const opened = await fetch(`${base}/api/sessions/${oldId}`, { headers });
		assert.equal(opened.status, 200);
		const result = (await opened.json()) as { session: { id: string; path: string }; history: unknown };
		assert.equal(result.session.id, manager.getSessionId());
		assert.equal(result.session.path, manager.getSessionFile());
		assert.match(JSON.stringify(result.history), /current history/);
		assert.equal(await readFile(a, "utf8"), archived);
		await rm(manager.getSessionFile()!);
		const brokenList = await fetch(`${base}/api/sessions`, { headers });
		const remaining = (await brokenList.json()) as { sessions: Array<{ id: string }> };
		assert.ok(remaining.sessions.some((info) => info.id === oldId));
		const broken = await fetch(`${base}/api/sessions/${oldId}`, { headers });
		assert.equal(broken.status, 400);
		assert.match(((await broken.json()) as { error: string }).error, /Broken Log Rotation chain/);
		assert.equal(await readFile(a, "utf8"), archived);
	} finally {
		if (server.listening)
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		if (previousAgentDir === undefined) delete process.env.THEOSES_CODING_AGENT_DIR;
		else process.env.THEOSES_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
