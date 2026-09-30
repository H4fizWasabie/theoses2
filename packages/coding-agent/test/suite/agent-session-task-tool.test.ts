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
});
