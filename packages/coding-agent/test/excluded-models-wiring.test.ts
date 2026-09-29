import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash";

describe("excludedModels reaches the model runtime", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `excluded-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("through the services factory", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ excludedModels: ["*deepseek*"] }),
		});
		expect(services.modelRuntime.getModel("openrouter", DEEPSEEK)).toBeUndefined();
		expect(services.modelRuntime.getModels().some((m) => m.id.includes("deepseek"))).toBe(false);
	});

	it("leaves the model alone without the setting", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
		});
		expect(services.modelRuntime.getModel("openrouter", DEEPSEEK)).toBeDefined();
	});

	it("through createAgentSession, which is where a session picks and switches models", async () => {
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory()));
		await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ excludedModels: ["*deepseek*"] }),
			sessionManager: SessionManager.inMemory(tempDir),
		});
		expect(runtime.getModel("openrouter", DEEPSEEK)).toBeUndefined();
		expect(runtime.getModels().some((m) => m.id.includes("deepseek"))).toBe(false);
	});
});
