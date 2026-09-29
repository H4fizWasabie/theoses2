import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// A failed edit must reach the model as an error result it can act on, must not touch the file, and must not end
// the run: the model re-reads the file and edits again.
describe("AgentSession edit failure recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(fileContent: string): Promise<{ harness: Harness; target: string }> {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "config.txt");
		writeFileSync(target, fileContent);
		return { harness, target };
	}

	const toolResults = (harness: Harness) =>
		harness.session.messages.flatMap((message) =>
			message.role === "toolResult"
				? [{ tool: message.toolName, isError: message.isError, text: getMessageText(message) }]
				: [],
		);

	it("reports a failed edit as an error result, leaves the file alone, and lets the model re-read and retry", async () => {
		const { harness, target } = await setup("timeout: 30\nretries: 3\n");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "config.txt", edits: [{ oldText: "timeout: 20", newText: "timeout: 60" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("read", { path: "config.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "config.txt", edits: [{ oldText: "timeout: 30", newText: "timeout: 60" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("raise the timeout to 60");

		const results = toolResults(harness);
		expect(results.map((r) => [r.tool, r.isError])).toEqual([
			["edit", true],
			["read", false],
			["edit", false],
		]);
		expect(results[0].text).toContain("Could not find the exact text");
		expect(readFileSync(target, "utf8")).toBe("timeout: 60\nretries: 3\n");
	});

	it("does not touch the file when one edit of several is rejected", async () => {
		const original = "timeout: 30\nretries: 3\n";
		const { harness, target } = await setup(original);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "config.txt",
					edits: [
						{ oldText: "timeout: 30", newText: "timeout: 60" },
						{ oldText: "retries: 9", newText: "retries: 5" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("gave up"),
		]);

		await harness.session.prompt("change both");

		const [result] = toolResults(harness);
		expect(result).toMatchObject({ tool: "edit", isError: true });
		expect(result.text).toContain("No changes applied");
		expect(readFileSync(target, "utf8")).toBe(original);
	});

	it("says which lines collide when the text to replace is not unique", async () => {
		const original = "return total * 2;\nreturn total * 2;\n";
		const { harness, target } = await setup(original);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "config.txt",
					edits: [{ oldText: "return total * 2;", newText: "return total * 3;" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("gave up"),
		]);

		await harness.session.prompt("triple it");

		const [result] = toolResults(harness);
		expect(result).toMatchObject({ tool: "edit", isError: true });
		expect(result.text).toContain("2 occurrences");
		expect(result.text).toContain("lines 1, 2");
		expect(readFileSync(target, "utf8")).toBe(original);
	});
});
