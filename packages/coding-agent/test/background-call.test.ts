import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "theoses-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

vi.mock("../src/core/background-models.ts", () => ({
	resolveBackgroundModel: () => ({ id: "deepseek-v4", maxTokens: 4096 }),
}));

import { backgroundCall } from "../src/core/background-call.ts";

function reply(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "deepseek-v4",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "background-call-"));
	vi.stubEnv("THEOSES_CODING_AGENT_DIR", agentDir);
});
afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe("backgroundCall", () => {
	it("sends one tool-less user message, retries a transient error, and logs the final call's cost", async () => {
		const completeSimple = vi
			.fn()
			.mockResolvedValueOnce(reply({ stopReason: "error", errorMessage: "503 service unavailable" }))
			.mockResolvedValueOnce(reply({ responseModel: "deepseek/deepseek-v4" }));
		const modelRuntime = { completeSimple } as unknown as ModelRuntime;

		const response = await backgroundCall(modelRuntime, {
			caller: "task-boundary",
			prompt: "summarize",
			sessionId: "telegram:1",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			responseFormat: { type: "json_object" },
		});

		expect(response.stopReason).toBe("stop");
		expect(completeSimple).toHaveBeenCalledTimes(2);
		const [, context, options] = completeSimple.mock.calls[0];
		expect(context.messages).toEqual([
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "summarize" }] }),
		]);
		expect(options).toEqual({
			maxTokens: 4096,
			toolChoice: "none",
			sessionId: "telegram:1",
			responseFormat: { type: "json_object" },
		});
		const lines = readFileSync(join(agentDir, "consolidation-usage.jsonl"), "utf-8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ cost: 0.002, model: "deepseek/deepseek-v4", caller: "task-boundary" }),
		]);
	});
});
