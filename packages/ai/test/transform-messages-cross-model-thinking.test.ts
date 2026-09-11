import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function assistantWithThinking(thinking: string, sourceModel: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: "" }],
		api: sourceModel.api,
		provider: sourceModel.provider,
		model: sourceModel.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("transformMessages cross-model thinking replay", () => {
	it("bounds an oversized thinking trace when downgraded to text for a different model", () => {
		const sourceModel = model("z-ai/glm-5.3-flash");
		const destModel = model("deepseek/deepseek-v4.1-flash");
		const hugeThinking = "x".repeat(500_000);

		const [transformed] = transformMessages([assistantWithThinking(hugeThinking, sourceModel)], destModel);
		if (transformed.role !== "assistant") throw new Error("expected assistant message");
		const textBlock = transformed.content.find((b) => b.type === "text");

		expect(textBlock).toBeTruthy();
		expect(textBlock?.type === "text" && textBlock.text.length).toBeLessThan(hugeThinking.length);
		expect(textBlock?.type === "text" && textBlock.text).toContain("more characters of prior reasoning omitted");
	});

	it("leaves a short thinking trace untouched when downgraded for a different model", () => {
		const sourceModel = model("z-ai/glm-5.3-flash");
		const destModel = model("deepseek/deepseek-v4.1-flash");
		const shortThinking = "Deciding whether to call the read tool.";

		const [transformed] = transformMessages([assistantWithThinking(shortThinking, sourceModel)], destModel);
		if (transformed.role !== "assistant") throw new Error("expected assistant message");
		const textBlock = transformed.content.find((b) => b.type === "text");

		expect(textBlock?.type === "text" && textBlock.text).toBe(shortThinking);
	});

	it("preserves the full thinking block when replaying into the same model", () => {
		const sourceModel = model("deepseek/deepseek-v4.1-flash");
		const hugeThinking = "x".repeat(500_000);

		const [transformed] = transformMessages(
			[assistantWithThinking(hugeThinking, sourceModel)],
			model("deepseek/deepseek-v4.1-flash"),
		);
		if (transformed.role !== "assistant") throw new Error("expected assistant message");
		const thinkingBlock = transformed.content.find((b) => b.type === "thinking");

		expect(thinkingBlock?.type === "thinking" && thinkingBlock.thinking).toBe(hugeThinking);
	});
});
