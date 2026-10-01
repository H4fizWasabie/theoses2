import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.create forwards agentDir when sessionDir is omitted", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `agent-dir-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lands the default session under the provided agentDir, not the real agent dir", () => {
		const session = SessionManager.create(cwd, undefined, undefined, agentDir);
		const expectedDir = getDefaultSessionDir(cwd, agentDir);

		expect(session.getSessionDir()).toBe(expectedDir);
		expect(session.getSessionDir().startsWith(`${agentDir}/`)).toBe(true);
	});

	it("marks a session created under a custom agentDir's default path as default", () => {
		const session = SessionManager.create(cwd, undefined, undefined, agentDir);

		expect(session.usesDefaultSessionDir()).toBe(true);
	});

	it("keeps an explicit sessionDir overriding agentDir", () => {
		const explicit = join(tempDir, "custom-sessions");
		mkdirSync(explicit, { recursive: true });

		const session = SessionManager.create(cwd, explicit, undefined, agentDir);

		expect(session.getSessionDir()).toBe(explicit);
	});
});
