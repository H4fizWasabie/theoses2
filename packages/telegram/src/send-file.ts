import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Type } from "theoses-ai";
import type { ToolDefinition } from "theoses-coding-agent";

/** Bot API upload limits: photos up to 10 MB, any other file up to 50 MB. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export interface FileSender {
	sendPhoto(data: Buffer, fileName: string, caption: string | undefined): Promise<number>;
	sendDocument(data: Buffer, fileName: string, caption: string | undefined): Promise<number>;
}

const sendFileSchema = Type.Object({
	path: Type.String({ description: "Path of the file to send (relative or absolute)" }),
	caption: Type.Optional(Type.String({ description: "Short caption shown under the file" })),
});

/**
 * send_file: puts a file from disk in front of the owner in this chat. Before it existed the model had no
 * way to do that - `read` only shows an image to the model - so it claimed "sent inline" for an image the
 * owner never received, then fell back to a hand-rolled curl to the Bot API with the token (2026-09-28).
 */
export function createSendFileTool(cwd: string, sender: FileSender): ToolDefinition<typeof sendFileSchema> {
	return {
		name: "send_file",
		label: "send_file",
		description:
			"Send a file from disk to the user in this Telegram chat. Images (jpg, png, webp, up to 10 MB) arrive as a photo, anything else as a document (up to 50 MB).",
		promptSnippet: "Send a file or image to the user in this Telegram chat",
		promptGuidelines: [
			"read shows a file only to you, never to the user. To show the user an image or file that is on disk, call send_file.",
			"Only tell the user a file was sent after send_file succeeded.",
		],
		parameters: sendFileSchema,
		async execute(_toolCallId, { path, caption }) {
			const absolutePath = resolve(cwd, path);
			const info = await stat(absolutePath);
			if (!info.isFile()) throw new Error(`Not a file: ${absolutePath}`);
			const fileName = basename(absolutePath);
			const asPhoto = PHOTO_EXTENSIONS.has(extname(fileName).toLowerCase()) && info.size <= PHOTO_MAX_BYTES;
			if (!asPhoto && info.size > DOCUMENT_MAX_BYTES) {
				throw new Error(`${fileName} is ${info.size} bytes; Telegram bots can send at most 50 MB`);
			}
			const data = await readFile(absolutePath);
			const messageId = asPhoto
				? await sender.sendPhoto(data, fileName, caption)
				: await sender.sendDocument(data, fileName, caption);
			return {
				content: [{ type: "text", text: `Sent ${fileName} to the user as a ${asPhoto ? "photo" : "document"}.` }],
				details: { messageId, kind: asPhoto ? "photo" : "document" },
			};
		},
	};
}
