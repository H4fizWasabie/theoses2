import type { Message } from "grammy/types";
import type { ChannelInput } from "theoses-coding-agent";

/**
 * What the owner sent, read once per update. Commands are recognized before the turn is queued (a /stop
 * must never wait behind the turn it stops); a prompt's attachments are resolved later, inside its queued
 * turn, by resolvePrompt.
 */
export type Inbound =
	| { kind: "stop" }
	| { kind: "toolCallDetail"; on: boolean }
	| { kind: "model"; ref: string }
	| { kind: "prompt" };

const STOP_COMMANDS = new Set(["stop", "halt", "/stop", "/cancel"]);
const TOOL_CALL_DETAIL_ON = new Set(["/on tool call", "/on tool calls"]);
const TOOL_CALL_DETAIL_OFF = new Set(["/off tool call", "/off tool calls"]);

export function readInbound(message: Message): Inbound {
	const text = messageText(message);
	const normalized = text.trim().toLowerCase();
	// An explicit "/stop"/"/cancel" command or a bare "stop"/"halt" message.
	if (STOP_COMMANDS.has(normalized)) return { kind: "stop" };
	// Toggle for per-tool-call status entries.
	if (TOOL_CALL_DETAIL_ON.has(normalized)) return { kind: "toolCallDetail", on: true };
	if (TOOL_CALL_DETAIL_OFF.has(normalized)) return { kind: "toolCallDetail", on: false };
	const ref = parseModelCommand(text);
	if (ref !== undefined) return { kind: "model", ref };
	return { kind: "prompt" };
}

/**
 * Parses "/model <provider/id or bare id>" out of a message, or undefined if the message
 * isn't a /model command. Bare "/model" returns "" - there is no interactive picker here
 * (unlike the CLI TUI), so it just reports the current model and how to switch.
 */
export function parseModelCommand(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "/model") return "";
	if (trimmed.toLowerCase().startsWith("/model ")) return trimmed.slice("/model ".length).trim();
	return undefined;
}

export interface AttachmentStore {
	download(fileId: string): Promise<Uint8Array>;
	storeArtifact(label: string, fileName: string, data: Uint8Array): string;
}

/**
 * Builds the turn's prompt from a message or an album (several messages sharing a media_group_id):
 * photos and image documents become images, other files are stored as session artifacts. The text is
 * the first caption found; a caption-less attachment gets a note instead, or an empty string would reach
 * the agent and the attachment be silently ignored (2026-09-08 fix). Turn Settlement sees only what the
 * owner wrote, never that note.
 */
export async function resolvePrompt(album: Message[], attachments: AttachmentStore): Promise<ChannelInput> {
	const text = album.map(messageText).find(Boolean) ?? "";
	const images: string[] = [];
	let attachmentNote: string | undefined;
	const noteFor = (name: string, mime: string, size: number, kind: string) =>
		`User sent a ${kind} without a caption: "${name}" (mime type ${mime}, ${size} bytes). ` +
		`It has been stored as a document artifact in this session. Use convert_doc to read it if needed, and respond about it.`;
	for (const message of album) {
		if (message.photo?.length) {
			const photo = message.photo.at(-1);
			if (photo) {
				const data = await attachments.download(photo.file_id);
				images.push(`data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`);
				attachmentNote = "User sent a photo without a caption. Describe or act on it as appropriate.";
			}
		} else if (message.document) {
			const document = message.document;
			const data = await attachments.download(document.file_id);
			if (document.mime_type?.startsWith("image/")) {
				images.push(`data:${document.mime_type};base64,${Buffer.from(data).toString("base64")}`);
			} else {
				const name = document.file_name ?? "document";
				attachments.storeArtifact("telegram document", name, data);
				attachmentNote = noteFor(name, document.mime_type ?? "unknown", data.length, "document");
			}
		} else {
			// Other media types (audio, video, voice, video note, animation) were previously
			// dropped silently. Store what we can so the agent knows they arrived.
			const media = message.audio ?? message.video ?? message.voice ?? message.video_note ?? message.animation;
			if (media?.file_id) {
				try {
					const data = await attachments.download(media.file_id);
					const meta = media as { file_name?: string; mime_type?: string };
					const name = meta.file_name ?? meta.mime_type ?? "media";
					attachments.storeArtifact("telegram document", name, data);
					attachmentNote = noteFor(name, meta.mime_type ?? "unknown", data.length, "media file");
				} catch (e) {
					console.error("Failed to download non-document media:", e);
				}
			}
		}
	}
	return {
		text: text || attachmentNote || "",
		images: images.length ? images : undefined,
		replyContext: album[0] ? replyText(album[0]) : undefined,
		settlementText: text,
	};
}

function messageText(message: Message): string {
	// A rich message (formatted paste, table) has no .text at all - without this fallback it reached
	// the model as an empty prompt (2026-09-24: a Mini Pharmacy report arrived as nothing).
	return (
		message.text ?? message.caption ?? flattenRichMessage((message as { rich_message?: unknown }).rich_message) ?? ""
	);
}

/** The text of the message being replied to, if any. */
export function replyText(message: Message): string | undefined {
	const reply = message.reply_to_message;
	const text = reply?.text ?? reply?.caption;
	if (text) return text;
	return flattenRichMessage((reply as { rich_message?: unknown } | undefined)?.rich_message);
}

/** Metadata keys whose string values aren't message text. `label` is prefixed separately. */
const RICH_NON_TEXT_KEYS = new Set(["type", "url", "label", "language"]);

/**
 * Recursively pulls plain text out of a rich-message block/span tree. The shape isn't publicly
 * documented, so this walks every property except known metadata rather than a fixed list: a block
 * type not seen before (e.g. a table's rows/cells) keeps its text instead of vanishing. Inline span
 * runs (anything under `text`) join directly; other arrays (blocks, items, rows, cells) put one
 * entry per line so separate blocks don't run together.
 */
function flattenRichNode(node: unknown, inline = false): string {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (Array.isArray(node))
		return node
			.map((child) => flattenRichNode(child, inline))
			.filter(Boolean)
			.join(inline ? "" : "\n");
	if (typeof node !== "object") return "";
	const parts = Object.entries(node)
		.filter(([key]) => !RICH_NON_TEXT_KEYS.has(key))
		.map(([key, value]) => flattenRichNode(value, inline || key === "text"))
		.filter(Boolean);
	if (!parts.length) return "";
	const label = (node as { label?: unknown }).label;
	return typeof label === "string" ? `${label} ${parts.join(" ")}` : parts.join(" ");
}

/**
 * A message sent via sendRichMessage/rich editMessageText comes back (as the inbound message or on
 * reply_to_message) with no `.text`/`.caption` at all - Telegram only echoes a `rich_message.blocks`
 * tree for those. Verified directly against a live reply payload before wiring this in (a reply to a
 * rich answer was silently losing its quoted context - the bare .text/.caption check never found anything).
 */
function flattenRichMessage(richMessage: unknown): string | undefined {
	const blocks = (richMessage as { blocks?: unknown } | undefined)?.blocks;
	if (!Array.isArray(blocks)) return undefined;
	const text = flattenRichNode(blocks).trim();
	return text || undefined;
}
