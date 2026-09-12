import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRecallTurnsToolDefinition } from "../src/core/tools/recall-turns.ts";

function ctxFor(manager: SessionManager): ExtensionContext {
	return { sessionManager: manager } as ExtensionContext;
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
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "the deploy key is stored in vault-7" }] });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "got it, noted" }] });

		const text = await resultTextOf(manager, "deploy key vault");
		expect(text).toContain("vault-7");
	});

	it("never returns tool-call arguments or tool results, only chat text", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "checking the secret file now" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/etc/super-secret-token.txt" } },
			],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			content: [{ type: "text", text: "TOKEN=abc123supersecret" }],
		});

		const text = await resultTextOf(manager, "secret token");
		expect(text).not.toContain("abc123supersecret");
		expect(text).not.toContain("/etc/super-secret-token.txt");
	});

	it("returns a no-match message when nothing overlaps the query", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "let's talk about pizza toppings" }] });

		const text = await resultTextOf(manager, "kubernetes deployment yaml");
		expect(text).toBe("No matching turns found in this session.");
	});

	it("ranks a turn matching more query terms above one matching fewer", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "the invoice total is nine dollars" }] });
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "the invoice number is INV-42 and the invoice total is confirmed" }],
		});

		const text = await resultTextOf(manager, "invoice total confirmed");
		const lines = text.split("\n");
		expect(lines[0]).toContain("INV-42");
	});
});
