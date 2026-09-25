import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "theoses-ai/compat";
import { createDashboardServer } from "../src/index.ts";

async function listen(server: ReturnType<typeof createDashboardServer>): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("dashboard server did not expose a port");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createDashboardServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("dashboard protects APIs and accepts browser cookies and bearer tokens", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-auth-"));
	const server = createDashboardServer({ accessToken: "test-owner-token" });
	const base = await listen(server);
	try {
		const asset = await fetch(`${base}/`);
		assert.equal(asset.status, 200);

		const unauthenticated = await fetch(`${base}/api/files?path=${encodeURIComponent(root)}`);
		assert.equal(unauthenticated.status, 401);

		const invalidLogin = await fetch(`${base}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "wrong" }),
		});
		assert.equal(invalidLogin.status, 401);

		const login = await fetch(`${base}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "test-owner-token" }),
		});
		assert.equal(login.status, 200);
		const setCookie = login.headers.get("set-cookie");
		assert.ok(setCookie);
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /SameSite=Strict/);

		const browserRequest = await fetch(`${base}/api/files?path=${encodeURIComponent(root)}`, {
			headers: { cookie: setCookie.split(";", 1)[0] },
		});
		assert.equal(browserRequest.status, 200);

		const agentRequest = await fetch(`${base}/api/files?path=${encodeURIComponent(root)}`, {
			headers: { Authorization: "Bearer test-owner-token" },
		});
		assert.equal(agentRequest.status, 200);
	} finally {
		await close(server);
	}
});

test("dashboard fails closed when no access token is configured", async () => {
	const server = createDashboardServer({ accessToken: "" });
	const base = await listen(server);
	try {
		const response = await fetch(`${base}/api/sessions`);
		assert.equal(response.status, 503);
	} finally {
		await close(server);
	}
});

test("dashboard saves Telegram onboarding settings without exposing the bot token", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-telegram-"));
	const configPath = join(root, "theoses.env");
	await writeFile(configPath, "OTHER_SETTING=preserved\n");
	await chmod(configPath, 0o600);
	const server = createDashboardServer({ accessToken: "test-owner-token", telegramConfigPath: configPath });
	const base = await listen(server);
	try {
		const unauthenticated = await fetch(`${base}/api/telegram`);
		assert.equal(unauthenticated.status, 401);

		const status = await fetch(`${base}/api/telegram`, {
			headers: { Authorization: "Bearer test-owner-token" },
		});
		const statusBody = await status.json();
		assert.deepEqual(statusBody, { configured: false, ownerTelegramId: null });
		assert.doesNotMatch(JSON.stringify(statusBody), /secret/);

		const saved = await fetch(`${base}/api/telegram`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token", "Content-Type": "application/json" },
			body: JSON.stringify({ botToken: "123:secret", ownerTelegramId: "-100123" }),
		});
		assert.deepEqual(await saved.json(), { ok: true, restartRequired: true });
		const savedConfig = await readFile(configPath, "utf8");
		assert.match(savedConfig, /OTHER_SETTING=preserved/);
		assert.match(savedConfig, /THEOSES_TELEGRAM_BOT_TOKEN=123:secret/);
		assert.equal((await stat(configPath)).mode & 0o777, 0o600);

		const configured = await fetch(`${base}/api/telegram`, {
			headers: { Authorization: "Bearer test-owner-token" },
		});
		assert.deepEqual(await configured.json(), { configured: true, ownerTelegramId: "-100123" });

		const invalid = await fetch(`${base}/api/telegram`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token", "Content-Type": "application/json" },
			body: JSON.stringify({ ownerTelegramId: "@owner" }),
		});
		assert.equal(invalid.status, 400);
	} finally {
		await close(server);
	}
});

test("dashboard session runtime info is read-only and never exposes credentials", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-runtime-"));
	const server = createDashboardServer({ accessToken: "test-owner-token", cwd: root });
	const base = await listen(server);
	try {
		const created = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token" },
		});
		assert.equal(created.status, 201);
		const session = (await created.json()) as { id: string };

		const opened = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}`, {
			headers: { Authorization: "Bearer test-owner-token" },
		});
		assert.equal(opened.status, 200);
		const body = (await opened.json()) as { runtime: Record<string, unknown> };

		assert.ok("runtime" in body);
		assert.ok("thinkingLevel" in body.runtime);
		assert.ok("modelId" in body.runtime);
		assert.ok("provider" in body.runtime);
		assert.ok("lastUsage" in body.runtime);

		// The runtime summary is a read-only display, never a place credentials could leak.
		const serialized = JSON.stringify(body);
		assert.doesNotMatch(serialized, /apiKey|api_key|credential|oauth|refresh|access_token/i);
	} finally {
		await close(server);
	}
});

test("dashboard reports a turn that fails with a provider error instead of ending silently", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-failure-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const faux = registerFauxProvider();
	const model = faux.getModel();
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[model.provider]: {
					baseUrl: model.baseUrl,
					apiKey: "faux-key",
					api: faux.api,
					models: [{ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input }],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } }),
	);
	const previousAgentDir = process.env.THEOSES_CODING_AGENT_DIR;
	process.env.THEOSES_CODING_AGENT_DIR = agentDir;
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider timed out" })]);
	const server = createDashboardServer({ accessToken: "test-owner-token", cwd: root });
	const base = await listen(server);
	try {
		const created = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token" },
		});
		const session = (await created.json()) as { id: string };

		const reply = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}/messages`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token", "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});
		const stream = await reply.text();
		assert.match(stream, /event: error\ndata: .*failed: Provider timed out/);
		assert.doesNotMatch(stream, /event: done/);
	} finally {
		await close(server);
		faux.unregister();
		if (previousAgentDir === undefined) delete process.env.THEOSES_CODING_AGENT_DIR;
		else process.env.THEOSES_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("dashboard shows a new session's live model before its file is written", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-live-model-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const faux = registerFauxProvider();
	const model = faux.getModel();
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[model.provider]: {
					baseUrl: model.baseUrl,
					apiKey: "faux-key",
					api: faux.api,
					models: [{ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input }],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }),
	);
	const previousAgentDir = process.env.THEOSES_CODING_AGENT_DIR;
	process.env.THEOSES_CODING_AGENT_DIR = agentDir;
	const server = createDashboardServer({ accessToken: "test-owner-token", cwd: root });
	const base = await listen(server);
	try {
		const created = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token" },
		});
		const session = (await created.json()) as { id: string };

		const opened = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}`, {
			headers: { Authorization: "Bearer test-owner-token" },
		});
		const body = (await opened.json()) as { runtime: { provider: string | null; modelId: string | null } };
		assert.equal(body.runtime.provider, model.provider);
		assert.equal(body.runtime.modelId, model.id);
	} finally {
		await close(server);
		faux.unregister();
		if (previousAgentDir === undefined) delete process.env.THEOSES_CODING_AGENT_DIR;
		else process.env.THEOSES_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("dashboard rejects a model switch to an unknown provider/id", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-model-"));
	const server = createDashboardServer({ accessToken: "test-owner-token", cwd: root });
	const base = await listen(server);
	try {
		const created = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token" },
		});
		const session = (await created.json()) as { id: string };

		const response = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}/model`, {
			method: "POST",
			headers: { Authorization: "Bearer test-owner-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: "no-such-provider/no-such-model" }),
		});
		assert.equal(response.status, 400);
		const body = (await response.json()) as { error: string };
		assert.match(body.error, /No exact match/);
	} finally {
		await close(server);
	}
});
