import type { AssistantMessage } from "theoses-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logServedProvider } from "../src/core/served-provider-log.ts";

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openrouter",
		model: "deepseek/deepseek-v4-flash-0731",
		usage: {
			input: 10,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 13,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

describe("logServedProvider", () => {
	afterEach(() => vi.restoreAllMocks());

	it("names the upstream provider that served the call", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logServedProvider(message({ responseProvider: "DeepInfra" }));
		expect(errorSpy).toHaveBeenCalledWith(
			"[provider] served model=deepseek/deepseek-v4-flash-0731 by=DeepInfra stop=stop out=3",
		);
	});

	it("stays silent when the provider does not report one", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logServedProvider(message({}));
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
