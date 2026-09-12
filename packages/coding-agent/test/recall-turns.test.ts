import type { AssistantMessage, Message, Usage } from "theoses-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRecallTurnsToolDefinition } from "../src/core/tools/recall-turns.ts";

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function toolResultMessage(toolCallId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function ctxFor(manager: SessionManager): ExtensionContext {
	return { sessionManager: manager } as unknown as ExtensionContext;
}

async function resultTextOf(manager: SessionManager, query: string): Promise<string> {
	const tool = createRecallTurnsToolDefinition();
	const result = await tool.execute("call-1", { query }, undefined, undefined, ctxFor(manager));
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("recall_turns (#231)", () => {
	it("finds a matching past user turn by keyword", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("the deploy key is stored in vault-7"));
		manager.appendMessage(assistantMessage([{ type: "text", text: "got it, noted" }]));

		const text = await resultTextOf(manager, "deploy key vault");
		expect(text).toContain("vault-7");
	});

	it("never returns tool-call arguments or tool results, only chat text", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			assistantMessage([
				{ type: "text", text: "checking the secret file now" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/etc/super-secret-token.txt" } },
			]),
		);
		manager.appendMessage(toolResultMessage("t1", "TOKEN=abc123supersecret"));

		const text = await resultTextOf(manager, "secret token");
		expect(text).not.toContain("abc123supersecret");
		expect(text).not.toContain("/etc/super-secret-token.txt");
	});

	it("returns a no-match message when nothing overlaps the query", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("let's talk about pizza toppings"));

		const text = await resultTextOf(manager, "kubernetes deployment yaml");
		expect(text).toBe("No matching turns found in this session.");
	});

	it("ranks a turn matching more query terms above one matching fewer", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("the invoice total is nine dollars"));
		manager.appendMessage(userMessage("the invoice number is INV-42 and the invoice total is confirmed"));

		const text = await resultTextOf(manager, "invoice total confirmed");
		const lines = text.split("\n");
		expect(lines[0]).toContain("INV-42");
	});
});
