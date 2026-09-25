import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot, type Context, InputFile } from "grammy";
import type { Update } from "grammy/types";
import {
	type AgentSessionEvent,
	configureHttpDispatcher,
	createChannelSessions,
	getAgentDir,
	type PromptResult,
} from "theoses-coding-agent";
import { chunkHtml, formatTelegramHtml, renderToolCallBlocks, splitSections, type ToolCallEntry } from "./format.ts";
import { createToolCallLogger } from "./tool-call-log.ts";
import { createTurnQueue } from "./turn-queue.ts";

// No settings.json override plumbing here (telegram doesn't load SettingsManager);
// this applies the shared default idle timeout globally so a stalled/looping
// provider stream is abandoned and retried well before OpenRouter's own
// much longer upstream timeout.
configureHttpDispatcher();

const CHANNEL = "telegram";
const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 120_000;
const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
// Telegram's typing indicator expires after ~5s, so it must be re-sent. 3s leaves room for a late timer
// or a slow API call before it lapses.
const TYPING_INTERVAL_MS = 3000;
/** How long an album leader waits for the rest of the group; Telegram gives no "album complete" signal. */
const ALBUM_WAIT_MS = 1000;
const TYPING_FAILURE_LOG_INTERVAL_MS = 30_000;
// Bot API's own documented ceiling for a rich message's text (headings/bold/tables/etc combined).
const RICH_MESSAGE_CHAR_LIMIT = 32768;
/**
 * A turn that still ends in a provider error after the session's own retries gets one automatic
 * follow-up after this delay - the same "Proceed" the owner otherwise had to type by hand (2026-09-24:
 * four Xiaomi stream timeouts left a PR task idle for 9 minutes). Any owner message cancels it.
 */
const AUTO_RESUME_DELAY_MS = 60_000;
const AUTO_RESUME_PROMPT =
	"[automatic resume] Your previous turn stopped on a provider error before finishing. Continue the task from where you left off.";

/**
 * Bot API 10.1 (June 2026) added sendRichMessage/InputRichMessage, with native pipe-table
 * rendering via its `markdown` field - the installed grammy (1.38.3) predates this and has no
 * typed support for it, so the params/response are typed locally and dispatched through
 * `bot.api.raw`, which forwards unrecognized method names to Telegram's HTTP API unchanged. Swap
 * this for grammy's own types once a grammy release adds them.
 */
interface SendRichMessageParams {
	chat_id: number;
	rich_message: { markdown: string };
	reply_parameters?: { message_id: number };
}
interface EditMessageTextRichParams {
	chat_id: number;
	message_id: number;
	rich_message: { markdown: string };
}
interface RawApiWithRichMessage {
	sendRichMessage(params: SendRichMessageParams): Promise<{ message_id: number }>;
	editMessageText(params: EditMessageTextRichParams): Promise<{ message_id: number }>;
}

/**
 * Telegram-only rich-message guidance (issues #195, #196). Headings and block quotes need no
 * guidance - theoses already produces `#`/`##`/`###` and `>` today and they ride #194's
 * unconditional rich attempt for free. Collapsible blocks and footnotes are genuinely new
 * content structure with no existing habit to piggyback on, so both get a judgment framing
 * (not a hardcoded length/tool-type rule, not "cite everything") per the resolved tickets.
 */
const TELEGRAM_RICH_FORMATTING_GUIDANCE = `TELEGRAM RICH FORMATTING:
Replies here render through Telegram's rich-message format. Headings and quotes you already write
render natively with no change needed. Two more tools are available - use judgment about when they
help, not as a default:
- Collapsible blocks (<details><summary>short summary</summary>full detail</details>): use when a
  reply's main point is short but there's secondary detail worth keeping (full command output, a
  long log, a diagnostic dump) - so the summary alone answers, and the detail is there if wanted.
  Don't collapse something short, or something that IS the answer.
- Footnotes ([^id] reference plus a [^id]: definition line): use when citing a specific external
  source worth being able to verify (a particular doc, a particular web_search result) - not for
  every claim. General or well-known knowledge doesn't need one.`;

function chatId(ctx: Context): string | undefined {
	return ctx.chat?.id.toString();
}

const STOP_COMMANDS = new Set(["stop", "halt", "/stop", "/cancel"]);

/** Recognizes an explicit "/stop"/"/cancel" command or a bare "stop"/"halt" message, case-insensitively. */
function isStopCommand(text: string): boolean {
	return STOP_COMMANDS.has(text.trim().toLowerCase());
}

const TOOL_CALL_DETAIL_ON = new Set(["/on tool call", "/on tool calls"]);
const TOOL_CALL_DETAIL_OFF = new Set(["/off tool call", "/off tool calls"]);

/** Toggle command for per-tool-call collapsible detail blocks, or undefined if the message isn't one. */
function parseToolCallDetailToggle(text: string): boolean | undefined {
	const normalized = text.trim().toLowerCase();
	if (TOOL_CALL_DETAIL_ON.has(normalized)) return true;
	if (TOOL_CALL_DETAIL_OFF.has(normalized)) return false;
	return undefined;
}

/**
 * Whether to render each tool call as its own one-line status entry (icon + name + one-line
 * preview of its command/path/query, nothing more) instead of the default flat "Running bash..."
 * status and collapsed tool-name footer. Deliberately never shows the raw args or tool result -
 * see the comment on renderToolCallBlocks for why. Off by default - opt in with "/on tool call",
 * back out with "/off tool call". Persisted to a small file so the choice survives process
 * restarts (the auto-updater restarts this service routinely; an in-memory-only toggle would
 * silently reset).
 */
function loadToolCallDetailPreference(): boolean {
	try {
		const raw = readFileSync(join(getAgentDir(), "telegram-preferences.json"), "utf-8");
		return (JSON.parse(raw) as { toolCallDetail?: boolean }).toolCallDetail ?? false;
	} catch {
		return false;
	}
}

function saveToolCallDetailPreference(enabled: boolean): void {
	try {
		writeFileSync(
			join(getAgentDir(), "telegram-preferences.json"),
			`${JSON.stringify({ toolCallDetail: enabled })}\n`,
		);
	} catch (error) {
		console.error("Failed to save telegram tool-call detail preference:", error);
	}
}

/**
 * Parses "/model <provider/id or bare id>" out of a message, or undefined if the message
 * isn't a /model command. Unlike /stop, this only matches with an argument - "/model" alone
 * has no interactive picker to fall back to here (unlike the CLI TUI), so it's left unhandled
 * to just tell the user how to use it.
 */
export function parseModelCommand(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "/model") return "";
	if (trimmed.toLowerCase().startsWith("/model ")) return trimmed.slice("/model ".length).trim();
	return undefined;
}

function messageText(ctx: Context): string {
	const message = ctx.message;
	// A rich message (formatted paste, table) has no .text at all - without this fallback it reached
	// the model as an empty prompt (2026-09-24: a Mini Pharmacy report arrived as nothing).
	return (
		message?.text ??
		message?.caption ??
		flattenRichMessage((message as { rich_message?: unknown } | undefined)?.rich_message) ??
		""
	);
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
 * A message sent via sendRichMessage/rich editMessageText (see RawApiWithRichMessage above) comes
 * back on reply_to_message with no `.text`/`.caption` at all - Telegram only echoes a
 * `rich_message.blocks` tree for those, so replyText() falls back to flattening it. Verified
 * directly against a live reply payload before wiring this in (a reply to a rich answer was
 * silently losing its quoted context - the bare .text/.caption check never found anything).
 */
function flattenRichMessage(richMessage: unknown): string | undefined {
	const blocks = (richMessage as { blocks?: unknown } | undefined)?.blocks;
	if (!Array.isArray(blocks)) return undefined;
	const text = flattenRichNode(blocks).trim();
	return text || undefined;
}

export function replyText(ctx: Context): string | undefined {
	const reply = ctx.message?.reply_to_message;
	const text = reply?.text ?? reply?.caption;
	if (text) return text;
	return flattenRichMessage((reply as { rich_message?: unknown } | undefined)?.rich_message);
}

function assistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	const text = event.message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	return text || undefined;
}

/** Pulls image attachments (e.g. from generate_image) out of a raw tool result for delivery as Telegram photos. */
function extractGeneratedImages(result: unknown): Buffer[] {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: "image"; data: string } => (part as { type?: string })?.type === "image")
		.map((part) => Buffer.from(part.data, "base64"));
}

/**
 * Single exit point for outbound Telegram text: section-split on --- lines ->
 * format -> chunk -> send. Each section threads to the previous one (the
 * caller's message for the first) so multi-part replies read as one chain.
 * A chunk Telegram rejects (malformed HTML -> 400) is resent as plain text -
 * stray tags beat a lost message. Ported from Mino's sendTelegramReply.
 *
 * If `statusMessageId` is given (a live "Running <tool>..." status message),
 * the very first chunk edits it in place instead of sending a new message,
 * so the status message becomes the final answer rather than being replaced
 * by a separate one.
 */
async function sendTelegramReply(
	bot: Bot,
	chatId: number,
	reply: string,
	toolNames: string[],
	replyTo: number | undefined,
	statusMessageId: number | undefined,
): Promise<void> {
	const sections = splitSections(reply);
	let lastId = replyTo;
	let pendingEditId = statusMessageId;
	for (const [index, section] of sections.entries()) {
		// Rich messages (Bot API 10.1) render the full toolkit (tables, headings, collapsible
		// blocks, footnotes, block quotes, ...) natively instead of the classic HTML fallback
		// below - attempted unconditionally for every section that fits the rich message char
		// limit (issue #194: rich markdown is a strict superset of what classic HTML handles, so
		// a plain reply renders identically either way - a content-based gate only adds
		// maintenance, not behavior). Works whether it's a fresh send or replacing the in-place
		// "Running <tool>..." status message (editMessageText also takes a rich_message param -
		// verified directly against the Bot API docs and a live send/edit round-trip before wiring
		// this in). No confirmed fallback behavior exists for clients that predate 10.1 (checked
		// the Bot API docs directly - undocumented), so this only ever *attempts* the rich path;
		// any failure - old client, malformed markdown, network error - is logged (never silently
		// swallowed) and falls through to the exact classic HTML path below, same "never lose the
		// message" contract chunkHtml's caller already relies on. Sections over the rich limit
		// skip straight to classic chunking rather than being split across multiple rich messages
		// (splitting rich markdown itself risks cutting mid-table/mid-list/mid-code-block; classic
		// chunking already splits safely at tag/newline boundaries).
		if (section.length <= RICH_MESSAGE_CHAR_LIMIT) {
			const editId = pendingEditId;
			const rawApi = bot.api.raw as unknown as RawApiWithRichMessage;
			try {
				if (editId !== undefined) {
					const sent = await rawApi.editMessageText({
						chat_id: chatId,
						message_id: editId,
						rich_message: { markdown: section },
					});
					lastId = sent.message_id;
					pendingEditId = undefined;
				} else {
					const replyParameters = lastId ? { message_id: lastId } : undefined;
					const sent = await rawApi.sendRichMessage({
						chat_id: chatId,
						rich_message: { markdown: section },
						reply_parameters: replyParameters,
					});
					lastId = sent.message_id;
				}
				continue; // this section is fully sent; move to the next one
			} catch (error) {
				console.warn(
					`[rich-message] ${editId !== undefined ? "edit" : "send"} failed, falling back to classic HTML:`,
					error instanceof Error ? error.message : error,
				);
				// Fall through to the classic HTML path for this section - pendingEditId is left
				// untouched so the classic path's own edit-then-fall-back-to-send logic still runs.
			}
		}

		const names = index === sections.length - 1 ? toolNames : [];
		const html = formatTelegramHtml(section, names);
		for (const chunk of chunkHtml(html, TELEGRAM_MESSAGE_LIMIT)) {
			const editId = pendingEditId;
			pendingEditId = undefined; // only the very first chunk overall replaces the status message
			if (editId !== undefined) {
				try {
					await bot.api.editMessageText(chatId, editId, chunk, { parse_mode: "HTML" });
					lastId = editId;
					continue;
				} catch {
					try {
						await bot.api.editMessageText(chatId, editId, chunk);
						lastId = editId;
						continue;
					} catch {
						// Status message may have been deleted or rate-limited; fall through to sending fresh.
					}
				}
			}
			const replyParameters = lastId ? { message_id: lastId } : undefined;
			try {
				const sent = await bot.api.sendMessage(chatId, chunk, {
					parse_mode: "HTML",
					reply_parameters: replyParameters,
				});
				lastId = sent.message_id;
			} catch {
				const sent = await bot.api
					.sendMessage(chatId, chunk, { reply_parameters: replyParameters })
					.catch(() => undefined);
				if (sent) lastId = sent.message_id;
			}
		}
	}
}

async function downloadFile(bot: Bot, token: string, fileId: string): Promise<Uint8Array> {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) throw new Error("Telegram file has no download path");
	const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
		signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Telegram file download returned HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > TELEGRAM_DOWNLOAD_MAX_BYTES) {
		throw new Error("Telegram file is too large");
	}
	if (!response.body) {
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.byteLength > TELEGRAM_DOWNLOAD_MAX_BYTES) throw new Error("Telegram file is too large");
		return data;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > TELEGRAM_DOWNLOAD_MAX_BYTES) {
			await reader.cancel();
			throw new Error("Telegram file is too large");
		}
		chunks.push(value);
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}

export interface TelegramBotOptions {
	token?: string;
	ownerChatId?: string;
	cwd?: string;
}

export function createTelegramBot(options: TelegramBotOptions = {}): Bot {
	const token = options.token ?? process.env.THEOSES_TELEGRAM_BOT_TOKEN;
	const ownerChatId = options.ownerChatId ?? process.env.THEOSES_TELEGRAM_CHAT_ID;
	if (!token) throw new Error("THEOSES_TELEGRAM_BOT_TOKEN is required");
	if (!ownerChatId) throw new Error("THEOSES_TELEGRAM_CHAT_ID is required");

	const bot = new Bot(token);
	// Deployments that run the bot from a versioned release directory (e.g. a `current`
	// symlink swapped on each release) must set THEOSES_TELEGRAM_CWD to a stable path.
	// process.cwd() resolves through such a symlink to the release's real physical path,
	// which changes every release and would otherwise silently orphan the running
	// session (and its Working Note/Active Context Window) on every update.
	const cwd = options.cwd ?? process.env.THEOSES_TELEGRAM_CWD ?? process.cwd();
	// No `tools:` allowlist: it would also hard-gate extension tools out of the registry (issue #211), and
	// convert_doc, needed for document uploads, is in the default active set. appendSystemPrompt (issues
	// #195/#196) adds Telegram-only rich-formatting guidance - collapsible blocks and footnotes have no
	// existing habit to build on - scoped to this channel so it never reaches the dashboard or CLI.
	const channelSessions = createChannelSessions({
		channel: CHANNEL,
		cwd,
		appendSystemPrompt: [TELEGRAM_RICH_FORMATTING_GUIDANCE],
	});
	const albums = new Map<string, Array<NonNullable<Context["message"]>>>();
	// Queue scheduling, /stop targeting, running-tool tracking and auto-resume - see turn-queue.ts.
	const turnQueue = createTurnQueue();
	let toolCallDetailEnabled = loadToolCallDetailPreference();

	// One typing indicator per chat, shared by every message queued for it. It starts when a message is
	// received (not when its turn reaches the model), so session load, attachment downloads and queue
	// waits are covered, and it ends when the last holder releases it.
	const typingIndicators = new Map<string, { holders: number; interval: ReturnType<typeof setInterval> }>();
	let lastTypingFailureLogAt = 0;
	const sendTyping = (id: number): void => {
		bot.api.sendChatAction(id, "typing").catch((error: unknown) => {
			// Failures used to be swallowed silently, which made a missing indicator undiagnosable.
			const now = Date.now();
			if (now - lastTypingFailureLogAt < TYPING_FAILURE_LOG_INTERVAL_MS) return;
			lastTypingFailureLogAt = now;
			console.error("Telegram typing indicator failed:", error instanceof Error ? error.message : error);
		});
	};
	const acquireTyping = (chat: string, id: number): (() => void) => {
		let indicator = typingIndicators.get(chat);
		if (!indicator) {
			sendTyping(id);
			indicator = { holders: 0, interval: setInterval(() => sendTyping(id), TYPING_INTERVAL_MS) };
			indicator.interval.unref?.();
			typingIndicators.set(chat, indicator);
		}
		indicator.holders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = typingIndicators.get(chat);
			if (!current) return;
			current.holders--;
			if (current.holders > 0) return;
			clearInterval(current.interval);
			typingIndicators.delete(chat);
		};
	};
	/** Telegram drops the typing status the moment the bot sends a message, so re-send it right after one. */
	const refreshTyping = (chat: string, id: number): void => {
		if (typingIndicators.has(chat)) sendTyping(id);
	};

	bot.on("message", async (ctx) => {
		const chat = chatId(ctx);
		if (chat !== ownerChatId || !ctx.message) return;

		// Any new owner message supersedes a scheduled auto-resume: it either continues the task itself or redirects it.
		const cancelledResume = turnQueue.cancelAutoResume(chat);

		const text = messageText(ctx);
		if (isStopCommand(text)) {
			if (cancelledResume) {
				await bot.api.sendMessage(ctx.chat.id, "Cancelled the automatic resume.");
				return;
			}
			const session = channelSessions.list().find((open) => open.channelSessionId === chat);
			if (session?.isRunning) {
				// Marked before the abort, which lets the next queued turn start.
				const queuedMessageId = turnQueue.nextQueuedMessageId(chat);
				if (queuedMessageId !== undefined) turnQueue.requestStop(chat, queuedMessageId);
				const { runningTool: activity } = await session.stop();
				await bot.api.sendMessage(
					ctx.chat.id,
					activity
						? `Halted. Was running: ${activity}.${queuedMessageId === undefined ? "" : " Also skipped your next queued message."}`
						: `Halted the in-progress reply.${queuedMessageId === undefined ? "" : " Also skipped your next queued message."}`,
				);
				return;
			}
			if (turnQueue.queueDepth(chat) === 0) {
				await bot.api.sendMessage(ctx.chat.id, "Nothing is running.");
				return;
			}
			const queuedMessageId = turnQueue.nextQueuedMessageId(chat);
			if (queuedMessageId === undefined) {
				await bot.api.sendMessage(ctx.chat.id, "Nothing is queued.");
				return;
			}
			turnQueue.requestStop(chat, queuedMessageId);
			await bot.api.sendMessage(ctx.chat.id, "Halted the queued message.");
			return;
		}

		const toolCallDetailToggle = parseToolCallDetailToggle(text);
		if (toolCallDetailToggle !== undefined) {
			toolCallDetailEnabled = toolCallDetailToggle;
			saveToolCallDetailPreference(toolCallDetailToggle);
			await bot.api.sendMessage(
				ctx.chat.id,
				toolCallDetailToggle
					? "Tool call detail: on. Each tool call now shows as its own one-line status entry (name + command preview, no raw output)."
					: "Tool call detail: off. Back to the compact tool-name footer.",
			);
			return;
		}

		// Telegram delivers an album as separate messages sharing a media_group_id. The first one
		// becomes the leader and handles them all as a single turn; the others just join its list.
		// The leader's wait for stragglers happens inside its queued job, not here: grammy processes
		// updates one at a time, so blocking this handler would also block the rest of the album.
		const album = [ctx.message];
		const albumKey = ctx.message.media_group_id ? `${chat}:${ctx.message.media_group_id}` : undefined;
		if (albumKey) {
			const pending = albums.get(albumKey);
			if (pending) {
				pending.push(ctx.message);
				return;
			}
			albums.set(albumKey, album);
		}

		const messageId = ctx.message.message_id;
		const releaseTyping = acquireTyping(chat, ctx.chat.id);
		turnQueue.trackDepth(chat);
		const next = turnQueue.enqueue(chat, messageId, async () => {
			if (albumKey) {
				await new Promise((resolve) => setTimeout(resolve, ALBUM_WAIT_MS));
				albums.delete(albumKey);
			}
			turnQueue.dequeue(chat, messageId);
			if (turnQueue.consumeStopRequest(chat, messageId)) return;
			const session = await channelSessions.open(chat);

			const modelArg = parseModelCommand(messageText(ctx));
			if (modelArg !== undefined) {
				if (!modelArg) {
					const current = session.model;
					await bot.api.sendMessage(
						ctx.chat.id,
						current
							? `Current model: ${current.provider}/${current.id}\nSwitch with: /model <provider/id>`
							: "No model set yet.\nSwitch with: /model <provider/id>",
					);
					return;
				}
				const switched = await session.switchModel(modelArg);
				await bot.api.sendMessage(
					ctx.chat.id,
					"error" in switched ? switched.error : `Model: ${switched.model.provider}/${switched.model.id}`,
				);
				return;
			}

			const captionText = messageText(ctx) || album.find((m) => m.caption)?.caption || "";
			const images: string[] = [];
			// Fallback prompt for caption-less attachments: without it, an empty string
			// reaches the agent and the attachment is silently ignored (2026-09-08 fix).
			let attachmentNote: string | undefined;
			const noteFor = (name: string, mime: string, size: number, kind: string) =>
				`User sent a ${kind} without a caption: "${name}" (mime type ${mime}, ${size} bytes). ` +
				`It has been stored as a document artifact in this session. Use convert_doc to read it if needed, and respond about it.`;
			for (const message of album) {
				if (message.photo?.length) {
					const photo = message.photo.at(-1);
					if (photo) {
						const data = await downloadFile(bot, token, photo.file_id);
						images.push(`data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`);
						if (!captionText)
							attachmentNote = "User sent a photo without a caption. Describe or act on it as appropriate.";
					}
				} else if (message.document) {
					const document = message.document;
					const data = await downloadFile(bot, token, document.file_id);
					if (document.mime_type?.startsWith("image/")) {
						images.push(`data:${document.mime_type};base64,${Buffer.from(data).toString("base64")}`);
					} else {
						session.storeArtifact("telegram document", document.file_name ?? "document", data);
						if (!captionText)
							attachmentNote = noteFor(
								document.file_name ?? "document",
								document.mime_type ?? "unknown",
								data.length,
								"document",
							);
					}
				} else {
					// Other media types (audio, video, voice, video note, animation) were previously
					// dropped silently. Store what we can so the agent knows they arrived.
					const media = message.audio ?? message.video ?? message.voice ?? message.video_note ?? message.animation;
					if (media?.file_id) {
						try {
							const data = await downloadFile(bot, token, media.file_id);
							const meta = media as { file_name?: string; mime_type?: string };
							const name = meta.file_name ?? meta.mime_type ?? "media";
							const mime = meta.mime_type ?? "unknown";
							session.storeArtifact("telegram document", name, data);
							if (!captionText) attachmentNote = noteFor(name, mime, data.length, "media file");
						} catch (e) {
							console.error("Failed to download non-document media:", e);
						}
					}
				}
			}

			let response: string | undefined;
			let result: PromptResult | undefined;
			let statusMessageId: number | undefined;
			let statusPending: Promise<unknown> = Promise.resolve();
			const setStatus = (text: string) => {
				statusPending = statusPending.then(async () => {
					try {
						if (statusMessageId === undefined) {
							const sent = await bot.api.sendMessage(ctx.chat.id, text, {
								reply_parameters: { message_id: ctx.message.message_id },
							});
							statusMessageId = sent.message_id;
							refreshTyping(chat, ctx.chat.id);
						} else {
							await bot.api.editMessageText(ctx.chat.id, statusMessageId, text);
						}
					} catch {
						// Ignore transient status failures (e.g. "message not modified", rate limits).
					}
				});
			};
			// Tool-call-detail variant: same in-place-edit shape, but through the rich-message path
			// for consistency with the rest of this turn's replies.
			const setRichStatus = (markdown: string) => {
				statusPending = statusPending.then(async () => {
					try {
						const rawApi = bot.api.raw as unknown as RawApiWithRichMessage;
						if (statusMessageId === undefined) {
							const sent = await rawApi.sendRichMessage({
								chat_id: ctx.chat.id,
								rich_message: { markdown },
								reply_parameters: { message_id: ctx.message.message_id },
							});
							statusMessageId = sent.message_id;
							refreshTyping(chat, ctx.chat.id);
						} else {
							await rawApi.editMessageText({
								chat_id: ctx.chat.id,
								message_id: statusMessageId,
								rich_message: { markdown },
							});
						}
					} catch {
						// Ignore transient status failures (e.g. "message not modified", rate limits).
					}
				});
			};
			const toolNames: string[] = [];
			const toolCallEntries: ToolCallEntry[] = [];
			const generatedImages: Buffer[] = [];
			const toolCallLogger = createToolCallLogger();
			const onEvent = (event: AgentSessionEvent) => {
				response = assistantText(event) ?? response;
				if (event.type === "tool_execution_start") {
					toolCallLogger.start(event.toolCallId);
					if (toolCallDetailEnabled) {
						toolCallEntries.push({ id: event.toolCallId, name: event.toolName, args: event.args });
						setRichStatus(renderToolCallBlocks(toolCallEntries));
					} else {
						setStatus(`Running ${event.toolName}...`);
					}
				}
				if (event.type === "tool_execution_end") {
					toolCallLogger.end(event);
					toolNames.push(event.toolName);
					generatedImages.push(...extractGeneratedImages(event.result));
					if (toolCallDetailEnabled) {
						const entry = toolCallEntries.find((e) => e.id === event.toolCallId);
						if (entry) {
							entry.done = true;
							entry.isError = event.isError;
						}
						setRichStatus(renderToolCallBlocks(toolCallEntries));
					}
				}
			};
			try {
				result = await session.submit(
					{
						text: captionText || attachmentNote || "",
						replyContext: replyText(ctx),
						images: images.length ? images : undefined,
						settlementText: messageText(ctx),
					},
					onEvent,
				);
			} finally {
				releaseTyping();
			}
			await statusPending;
			// /stop already replied; the halted turn's partial output is dropped.
			if (result?.outcome === "aborted") {
				if (statusMessageId !== undefined)
					await bot.api.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
				return;
			}
			// Tool-call-detail mode: the status message is the tool-call block, already fully
			// rendered by the last setRichStatus() call above - it stays as its own chat entry
			// rather than being overwritten with the answer, so the answer always lands as a
			// separate message instead of being glued onto (or replacing) the tool-call block.
			const editTarget = toolCallDetailEnabled ? undefined : statusMessageId;
			// Issue #211: a failed turn has no text for assistantText() to find, so without this the bot
			// went silent on provider failures. finalError is the last attempt's, after all retries.
			const lastError = result?.finalError;
			// Capped at one: a resume that fails again is reported and left for the owner.
			const autoResume = lastError !== undefined && messageText(ctx) !== AUTO_RESUME_PROMPT;
			const errorText =
				lastError &&
				`${lastError.provider}/${lastError.model} failed: ${lastError.message}` +
					(autoResume
						? `\nResuming automatically in ${AUTO_RESUME_DELAY_MS / 1000}s. Send any message to cancel.`
						: "");
			if (response) {
				const footerNames = toolCallDetailEnabled ? [] : toolNames;
				// Narration from before the failure must not hide it (2026-09-24: the owner saw only "Now
				// proving it works..." and assumed the model stopped without calling a tool).
				const reply = errorText ? `${response}\n\n${errorText}` : response;
				await sendTelegramReply(bot, ctx.chat.id, reply, footerNames, ctx.message.message_id, editTarget);
			} else if (errorText) {
				if (editTarget !== undefined) {
					await bot.api.editMessageText(ctx.chat.id, editTarget, errorText).catch(() => {});
				} else {
					await bot.api
						.sendMessage(ctx.chat.id, errorText, { reply_parameters: { message_id: ctx.message.message_id } })
						.catch(() => {});
				}
			} else if (editTarget !== undefined) {
				await bot.api.deleteMessage(ctx.chat.id, editTarget).catch(() => {});
			}
			// Issue #198: multiple images collected in one reply (e.g. several generate_image
			// calls in a turn) go out as one grouped album via sendMediaGroup instead of separate
			// sendPhoto messages - confirmed this happens repeatedly in real usage and previously
			// sent as N distinct messages. sendMediaGroup is a plain (non-rich-message) Bot API
			// call, independent of the rich-message fallback chain above - always used directly
			// when there's more than one image, regardless of anything else in the reply.
			if (generatedImages.length > 1) {
				await bot.api.sendMediaGroup(
					ctx.chat.id,
					generatedImages.map((image) => ({ type: "photo" as const, media: new InputFile(image) })),
				);
			} else if (generatedImages.length === 1) {
				await bot.api.sendPhoto(ctx.chat.id, new InputFile(generatedImages[0]));
			}

			if (autoResume) {
				// Re-enters through handleUpdate so the resume gets the normal queue, typing, status,
				// /stop and reply handling, threaded to the message that started the failed task.
				const resume: Update = {
					update_id: 0,
					message: {
						message_id: ctx.message.message_id,
						date: Math.floor(Date.now() / 1000),
						chat: ctx.message.chat,
						from: ctx.message.from,
						text: AUTO_RESUME_PROMPT,
					},
				};
				turnQueue.scheduleAutoResume(
					chat,
					() => {
						bot.handleUpdate(resume).catch((error: unknown) =>
							console.error("Telegram auto-resume failed:", error),
						);
					},
					AUTO_RESUME_DELAY_MS,
				);
			}
		});
		// Deliberately not awaited (issue #209): grammY's default bot.start() dispatches updates
		// strictly sequentially, so awaiting the full turn here - which can run for many minutes
		// on a long tool call - blocked the handler from returning, which blocked grammY from ever
		// invoking the handler again for the NEXT incoming update. That made a "/stop"/"stop"/
		// "halt" message (and anything else) undeliverable for the entire duration of an in-flight
		// turn, including the one command specifically meant to interrupt it. The turn itself is
		// still correctly ordered per chat via turnQueue's own chain; this only lets grammY's
		// own dispatch loop move on to the next update instead of waiting on it.
		void next
			.finally(() => {
				// Also covers turns that never reach the prompt: skipped by /stop, /model, or a failure.
				releaseTyping();
				turnQueue.untrackDepth(chat);
			})
			.catch(() => {});
	});

	return bot;
}

export async function runTelegramBot(options: TelegramBotOptions = {}): Promise<void> {
	const bot = createTelegramBot(options);
	await bot.start();
}

if (import.meta.main) await runTelegramBot();
