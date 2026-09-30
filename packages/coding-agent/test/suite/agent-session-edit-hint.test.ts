import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession edit sibling hint", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function editResult(editSiblingHint?: boolean): Promise<string> {
		const harness = await createHarness({ settings: editSiblingHint === undefined ? {} : { editSiblingHint } });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "stats.mjs"), "const sorted = [...nums].sort();\n");
		writeFileSync(join(harness.tempDir, "report.mjs"), "return [...nums].sort().reverse();\n");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "stats.mjs",
					edits: [{ oldText: "[...nums].sort()", newText: "[...nums].sort((a, b) => a - b)" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("fix the sort");
		return getMessageText(harness.session.messages.find((m) => m.role === "toolResult"));
	}

	it("adds the hint to the edit result when the setting is on", async () => {
		expect(await editResult(true)).toContain("also appears in report.mjs:1");
	});

	it("is on by default and can be turned off", async () => {
		expect(await editResult()).toContain("also appears in report.mjs:1");
		expect(await editResult(false)).not.toContain("also appears");
	});
});
