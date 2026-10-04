import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_CHECKPOINT_ENTRY_TYPE } from "../../src/core/file-checkpoints.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession task tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(enabled: boolean): Promise<Harness> {
		const harness = await createHarness({ persist: true, settings: { taskTool: { enabled } } });
		harnesses.push(harness);
		return harness;
	}

	it("is off unless the setting turns it on", async () => {
		const off = await setup(false);
		const on = await setup(true);

		expect(off.session.getActiveToolNames()).not.toContain("task");
		expect(on.session.getActiveToolNames()).toContain("task");
	});

	it("keeps the sub-agent's work out of the parent's context, but not out of the file checkpoints", async () => {
		const h = await setup(true);
		const target = join(h.tempDir, "a.txt");
		writeFileSync(target, "old\n");
		h.setResponses([
			// parent: delegate
			fauxAssistantMessage(fauxToolCall("task", { description: "rename", prompt: "change old to new in a.txt" }), {
				stopReason: "toolUse",
			}),
			// sub-agent: read, edit, summarize
			fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Changed a.txt line 1 from old to new."),
			// parent: reply
			fauxAssistantMessage("done"),
		]);

		await h.session.prompt("do it with a task");

		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(h.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const result = h.session.messages.find((m) => m.role === "toolResult");
		expect(getMessageText(result)).toBe("Changed a.txt line 1 from old to new.");
		expect(
			h.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === FILE_CHECKPOINT_ENTRY_TYPE),
		).toHaveLength(1);

		const userId = h.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")?.id;
		h.session.rewindFiles(userId as string);
		expect(readFileSync(target, "utf8")).toBe("old\n");
	});

	it("runs the sub-agent's tools with the parent's settings and through the parent's tool result handling", async () => {
		const seen: Array<{ toolName: string; text: string }> = [];
		const h = await createHarness({
			settings: { taskTool: { enabled: true }, shellCommandPrefix: "MARK=from-parent-prefix" },
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						const text = event.content.map((block) => (block.type === "text" ? block.text : "")).join("");
						seen.push({ toolName: event.toolName, text });
						return undefined;
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { description: "echo", prompt: "echo the mark" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: 'echo "mark=$MARK"' }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Echoed the mark."),
			fauxAssistantMessage("done"),
		]);

		await h.session.prompt("delegate it");

		expect(seen.map((call) => call.toolName)).toEqual(["bash", "task"]);
		expect(seen[0]?.text).toContain("mark=from-parent-prefix");
	});
});
