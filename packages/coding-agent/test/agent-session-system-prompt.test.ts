import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "theoses-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * Regression test for the system-prompt rebuild: before_agent_start must see the reasoning-budget note on a
 * cold turn, since that note depends on the model/thinkingLevel/thinkingBudgets that a stale rebuild dropped.
 */
describe("AgentSession system prompt: before_agent_start on a cold turn", () => {
	let tempDir: string;
	let agentDir: string;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("includes the reasoning-budget note in the system prompt extensions see", async () => {
		tempDir = join(tmpdir(), `pi-system-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		// api: "openai-completions" so openRouterReasoningBudget's api check passes; compat.thinkingFormat set
		// explicitly on the model below since the faux baseUrl doesn't sniff as OpenRouter's.
		const fauxProvider = registerFauxProvider({
			api: "openai-completions",
			models: [{ id: "reasoning-model", reasoning: true, maxTokens: 64000, contextWindow: 128000 }],
		});
		try {
			fauxProvider.setResponses([() => fauxAssistantMessage("done")]);
			const model = { ...fauxProvider.getModel(), compat: { thinkingFormat: "openrouter" as const } };

			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRegistry = await createInMemoryModelRegistry(authStorage);
			modelRegistry.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				api: fauxProvider.api,
				models: fauxProvider.models.map((m) => ({
					id: m.id,
					name: m.id,
					reasoning: m.reasoning,
					input: m.input,
					cost: m.cost,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
				})),
			});

			const settingsManager = SettingsManager.inMemory({ thinkingBudgets: { high: 16384 } });

			let seenSystemPrompt = "";
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async (event) => {
							seenSystemPrompt = event.systemPrompt;
							return undefined;
						});
					},
				],
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir,
				model,
				thinkingLevel: "high",
				settingsManager,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});

			await session.bindExtensions({});
			await session.prompt("hello");

			expect(seenSystemPrompt).toContain("<reasoning_budget>");
			expect(seenSystemPrompt).toContain("capped at 16384 tokens");

			session.dispose();
		} finally {
			fauxProvider.unregister();
		}
	});
});
