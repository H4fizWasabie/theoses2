import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { parseModelCommand, readInbound, replyText, resolvePrompt } from "../src/inbound.ts";

function message(fields: Record<string, unknown>): Message {
	return { message_id: 1, date: 1, chat: { id: 1, type: "private" }, ...fields } as unknown as Message;
}

function attachments(files: Record<string, string> = {}) {
	return {
		download: vi.fn(async (fileId: string) => new TextEncoder().encode(files[fileId] ?? fileId)),
		storeArtifact: vi.fn(() => "artifact-id"),
	};
}

describe("readInbound", () => {
	it.each(["/stop", "stop", " HALT ", "/cancel"])("reads %j as stop", (text) => {
		expect(readInbound(message({ text }))).toEqual({ kind: "stop" });
	});

	it("reads the tool-call-detail toggles", () => {
		expect(readInbound(message({ text: "/on tool calls" }))).toEqual({ kind: "toolCallDetail", on: true });
		expect(readInbound(message({ text: "/off tool call" }))).toEqual({ kind: "toolCallDetail", on: false });
	});

	it("reads /model with and without a reference", () => {
		expect(readInbound(message({ text: "/model a/b" }))).toEqual({ kind: "model", ref: "a/b" });
		expect(readInbound(message({ text: "/model" }))).toEqual({ kind: "model", ref: "" });
	});

	it("reads anything else, including a caption that says stop in passing, as a prompt", () => {
		expect(readInbound(message({ text: "please stop the server" }))).toEqual({ kind: "prompt" });
		expect(readInbound(message({ photo: [{ file_id: "p" }] }))).toEqual({ kind: "prompt" });
	});
});

describe("parseModelCommand", () => {
	it("returns undefined for non-/model messages", () => {
		expect(parseModelCommand("hello")).toBeUndefined();
		expect(parseModelCommand("/modeling something")).toBeUndefined();
	});

	it("returns an empty string for bare /model", () => {
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("  /model  ")).toBe("");
	});

	it("returns the trimmed argument for /model <ref>", () => {
		expect(parseModelCommand("/model deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
		expect(parseModelCommand("/model   z-ai/glm-5.3-flash  ")).toBe("z-ai/glm-5.3-flash");
	});
});

describe("resolvePrompt", () => {
	it("uses an album's caption, wherever it sits, as both the prompt and the settled text", async () => {
		const album = [
			message({ photo: [{ file_id: "p1" }] }),
			message({ photo: [{ file_id: "p2" }], caption: "compare these" }),
		];
		const input = await resolvePrompt(album, attachments());
		expect(input.text).toBe("compare these");
		expect(input.settlementText).toBe("compare these");
		expect(input.images).toHaveLength(2);
	});

	it("gives a caption-less photo a note, but settles no text for it", async () => {
		const input = await resolvePrompt([message({ photo: [{ file_id: "p" }] })], attachments());
		expect(input.text).toContain("User sent a photo without a caption");
		expect(input.settlementText).toBe("");
	});

	it("stores a non-image document as an artifact and points the agent at it", async () => {
		const store = attachments({ doc: "hello" });
		const input = await resolvePrompt(
			[message({ document: { file_id: "doc", file_name: "notes.pdf", mime_type: "application/pdf" } })],
			store,
		);
		expect(store.storeArtifact).toHaveBeenCalledWith("telegram document", "notes.pdf", expect.any(Uint8Array));
		expect(input.text).toContain('"notes.pdf" (mime type application/pdf, 5 bytes)');
		expect(input.images).toBeUndefined();
	});

	it("sends an image document as an image, not an artifact", async () => {
		const store = attachments();
		const input = await resolvePrompt(
			[message({ document: { file_id: "img", mime_type: "image/png" }, caption: "look" })],
			store,
		);
		expect(store.storeArtifact).not.toHaveBeenCalled();
		expect(input.images?.[0]).toMatch(/^data:image\/png;base64,/);
		expect(input.text).toBe("look");
	});

	it("carries the replied-to text as reply context", async () => {
		const input = await resolvePrompt(
			[message({ text: "why?", reply_to_message: { text: "it failed" } })],
			attachments(),
		);
		expect(input.replyContext).toBe("it failed");
	});
});

describe("replyText", () => {
	it("returns undefined when there is no reply", () => {
		expect(replyText(message({}))).toBeUndefined();
	});

	it("reads .text from a classic reply", () => {
		expect(replyText(message({ reply_to_message: { text: "hello" } }))).toBe("hello");
	});

	it("falls back to .caption when .text is absent", () => {
		expect(replyText(message({ reply_to_message: { caption: "a photo caption" } }))).toBe("a photo caption");
	});

	// Bot API 10.1 rich messages (sendRichMessage/rich editMessageText) come back on
	// reply_to_message with no .text/.caption at all - only a rich_message.blocks tree. Payload
	// shape below is exactly what a live reply to a rich-sent theoses answer returned.
	it("flattens rich_message.blocks when .text/.caption are absent", () => {
		const richMessage = {
			blocks: [
				{ type: "paragraph", text: "No need — already ran and finished. Summary:" },
				{
					type: "list",
					items: [
						{
							label: "•",
							blocks: [
								{
									type: "paragraph",
									text: [
										{ type: "bold", text: "Sync succeeded:" },
										" 3 posts synced across daily-quote, daily-jokes, github-repo-highlight, workplace-drama.",
									],
								},
							],
						},
						{
							label: "•",
							blocks: [
								{
									type: "paragraph",
									text: [
										{
											type: "bold",
											text: [{ type: "url", text: "learnings.md", url: "learnings.md" }, " regenerated"],
										},
										" for all 4 workspaces (fresh insight files the posting jobs read tomorrow).",
									],
								},
							],
						},
						{
							label: "•",
							blocks: [
								{ type: "paragraph", text: "Crontab is live again for tomorrow's automatic 21:30 KUL run." },
							],
						},
					],
				},
				{ type: "paragraph", text: "Nothing left to do tonight, abah." },
			],
		};

		const result = replyText(message({ reply_to_message: { rich_message: richMessage } }));
		expect(result).toContain("No need — already ran and finished. Summary:");
		expect(result).toContain(
			"Sync succeeded: 3 posts synced across daily-quote, daily-jokes, github-repo-highlight, workplace-drama.",
		);
		expect(result).toContain("learnings.md regenerated");
		expect(result).toContain("Nothing left to do tonight, abah.");
	});

	it("returns undefined for an empty or malformed rich_message", () => {
		expect(replyText(message({ reply_to_message: { rich_message: {} } }))).toBeUndefined();
		expect(replyText(message({ reply_to_message: { rich_message: { blocks: [] } } }))).toBeUndefined();
	});

	it("keeps text from block types it does not know", () => {
		const table = {
			blocks: [
				{
					type: "table",
					rows: [{ cells: [{ text: "Medicine" }] }, { cells: [{ text: "Paracetamol 500mg" }] }],
				},
			],
		};
		const result = replyText(message({ reply_to_message: { rich_message: table } }));
		expect(result).toContain("Paracetamol 500mg");
		expect(result).not.toContain("table");
	});
});
