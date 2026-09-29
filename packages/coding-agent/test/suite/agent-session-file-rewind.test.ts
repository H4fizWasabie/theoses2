import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "theoses-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_CHECKPOINT_ENTRY_TYPE } from "../../src/core/file-checkpoints.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession file rewind", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWithWriteTool(): Promise<Harness> {
		let directory = "";
		const write: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async (_toolCallId, params) => {
				const { path, content } = params as { path: string; content: string };
				writeFileSync(join(directory, path), content);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [write], persist: true });
		directory = harness.tempDir;
		harnesses.push(harness);
		return harness;
	}

	const firstUserEntryId = (h: Harness) => {
		const entry = h.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
		if (!entry) throw new Error("no user message");
		return entry.id;
	};

	it("checkpoints a file before the model's tool call changes it, and puts it back", async () => {
		const h = await harnessWithWriteTool();
		const target = join(h.tempDir, "a.txt");
		writeFileSync(target, "v0");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "v1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await h.session.prompt("change a");
		expect(readFileSync(target, "utf8")).toBe("v1");

		const userId = firstUserEntryId(h);
		expect(h.session.previewFileRewind(userId).restore).toEqual([{ path: target, hash: expect.any(String) }]);
		expect(h.session.rewindFiles(userId).restored).toEqual([target]);
		expect(readFileSync(target, "utf8")).toBe("v0");
	});

	it("deletes a file the model created", async () => {
		const h = await harnessWithWriteTool();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "new.txt", content: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("make a file");

		h.session.rewindFiles(firstUserEntryId(h));

		expect(existsSync(join(h.tempDir, "new.txt"))).toBe(false);
	});

	it("does not change what the model is sent", async () => {
		const h = await harnessWithWriteTool();
		writeFileSync(join(h.tempDir, "a.txt"), "v0");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "v1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await h.session.prompt("change a");

		expect(h.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(
			h.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === FILE_CHECKPOINT_ENTRY_TYPE),
		).toHaveLength(1);
	});
});
