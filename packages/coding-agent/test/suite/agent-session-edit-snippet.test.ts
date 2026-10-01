import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession edit result snippet", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function editResult(editSnippet?: boolean): Promise<string> {
		const harness = await createHarness({ settings: editSnippet === undefined ? {} : { editSnippet } });
		harnesses.push(harness);
		writeFileSync(
			join(harness.tempDir, "a.txt"),
			`${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "line 6", newText: "SIX" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("change line 6");
		return getMessageText(harness.session.messages.find((m) => m.role === "toolResult"));
	}

	it("adds the lines around the change when the setting is on", async () => {
		expect(await editResult(true)).toContain("6\tSIX");
	});

	it("is off by default", async () => {
		expect(await editResult()).not.toContain("Now reads");
		expect(await editResult(false)).not.toContain("Now reads");
	});
});
