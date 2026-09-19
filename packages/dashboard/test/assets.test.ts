import assert from "node:assert/strict";
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

test("the graph layout module is served as JavaScript alongside the app", async () => {
	const server = createDashboardServer({ accessToken: "test-owner-token" });
	const base = await listen(server);
	try {
		const response = await fetch(`${base}/graph-layout.js`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
		assert.match(await response.text(), /export function stepGraphSimulation/);

		const app = await (await fetch(`${base}/app.js`)).text();
		assert.match(app, /from "\.\/graph-layout\.js"/);
	} finally {
		await close(server);
	}
});

test("only the listed assets are served", async () => {
	const server = createDashboardServer({ accessToken: "test-owner-token" });
	const base = await listen(server);
	try {
		for (const path of ["/not-there.js", "/constructor", "/toString", "/package.json"]) {
			const response = await fetch(`${base}${path}`);
			assert.equal(response.status, 404, path);
		}
	} finally {
		await close(server);
	}
});
