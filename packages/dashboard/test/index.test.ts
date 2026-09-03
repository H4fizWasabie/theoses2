import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
