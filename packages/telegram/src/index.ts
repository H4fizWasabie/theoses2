import { Bot, type Context, InputFile } from "grammy";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	maybeRunConsolidation,
	type SessionInfo,
	SessionManager,
} from "theoses-coding-agent";
import { chunkHtml, formatTelegramHtml, splitSections } from "./format.ts";

const CHANNEL = "telegram";
const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 120_000;
const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_STOP_REQUEST_TTL_MS = 30_000;
const TYPING_INTERVAL_MS = 4000; // Telegram's typing indicator expires after ~5s, so it must be re-sent.

// Mirrors createAgentSession's own default tool set, plus convert_doc: Telegram
// document uploads are stored as artifacts (see the `ctx.message.document` branch
// below) and need convert_doc enabled to ever be read, since no channel enables it
// by default.
const TELEGRAM_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"working_note",
	"remember",
	"save_note",
	"convert_doc",
	"web_search",
	"generate_image",
];

function chatId(ctx: Context): string | undefined {
	return ctx.chat?.id.toString();
}

const STOP_COMMANDS = new Set(["stop", "halt", "/stop", "/cancel"]);

/** Recognizes an explicit "/stop"/"/cancel" command or a bare "stop"/"halt" message, case-insensitively. */
function isStopCommand(text: string): boolean {
	return STOP_COMMANDS.has(text.trim().toLowerCase());
}

function messageText(ctx: Context): string {
	return ctx.message?.text ?? ctx.message?.caption ?? "";
}

function replyText(ctx: Context): string | undefined {
	const reply = ctx.message?.reply_to_message;
	const text = reply?.text ?? reply?.caption;
	return text || undefined;
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

/** Re-sends the Telegram "typing..." chat action every few seconds until `signal` aborts. */
function startTypingIndicator(bot: Bot, chatId: number, signal: AbortSignal): void {
	const tick = () => void bot.api.sendChatAction(chatId, "typing").catch(() => {});
	tick();
	const interval = setInterval(tick, TYPING_INTERVAL_MS);
	signal.addEventListener("abort", () => clearInterval(interval));
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

async function sessionFor(
	chat: string,
	cwd: string,
	sessions: Map<string, Promise<AgentSession>>,
): Promise<AgentSession> {
	const existing = sessions.get(chat);
	if (existing) return existing;
	const created = (async () => {
		const key = { channel: CHANNEL, channelSessionId: chat };
		const matches: SessionInfo[] = await SessionManager.list(cwd, undefined, undefined, key);
		const sessionManager = matches[0]
			? SessionManager.open(matches[0].path, undefined, cwd)
			: SessionManager.create(cwd, undefined, key);
		const { session } = await createAgentSession({ sessionManager, tools: TELEGRAM_TOOLS, thinkingLevel: "high" });
		return session;
	})();
	sessions.set(chat, created);
	return created;
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
	const sessions = new Map<string, Promise<AgentSession>>();
	const queues = new Map<string, Promise<void>>();
	// Tracks the tool currently running for each chat, so a stop command can report what it interrupted.
	const runningTool = new Map<string, string | undefined>();
	// Set right before abort() so the in-flight message handler skips sending its own (partial/empty) reply.
	const haltedByStop = new Set<string>();
	const stopRequested = new Map<string, { messageId: number; timer: ReturnType<typeof setTimeout> }>();
	const queuedMessageIds = new Map<string, number[]>();
	const queueDepth = new Map<string, number>();
	const removeQueuedMessage = (chat: string, messageId: number): void => {
		const queued = queuedMessageIds.get(chat);
		if (!queued) return;
		const remaining = queued.filter((id) => id !== messageId);
		if (remaining.length > 0) queuedMessageIds.set(chat, remaining);
		else queuedMessageIds.delete(chat);
	};
	const requestStop = (chat: string, messageId: number): void => {
		const previous = stopRequested.get(chat);
		if (previous) clearTimeout(previous.timer);
		const timer = setTimeout(() => {
			const request = stopRequested.get(chat);
			if (request?.messageId === messageId) stopRequested.delete(chat);
		}, TELEGRAM_STOP_REQUEST_TTL_MS);
		stopRequested.set(chat, { messageId, timer });
	};
	const consumeStopRequest = (chat: string, messageId: number): boolean => {
		const request = stopRequested.get(chat);
		if (!request || request.messageId !== messageId) return false;
		clearTimeout(request.timer);
		stopRequested.delete(chat);
		return true;
	};

	bot.on("message", async (ctx) => {
		const chat = chatId(ctx);
		if (chat !== ownerChatId || !ctx.message) return;

		const text = messageText(ctx);
		if (isStopCommand(text)) {
			const existing = sessions.get(chat);
			const session = existing ? await existing : undefined;
			if (session?.isStreaming) {
				const queuedMessageId = queuedMessageIds.get(chat)?.[0];
				if (queuedMessageId !== undefined) requestStop(chat, queuedMessageId);
				haltedByStop.add(chat);
				const activity = runningTool.get(chat);
				await session.abort();
				await bot.api.sendMessage(
					ctx.chat.id,
					activity
						? `Halted. Was running: ${activity}.${queuedMessageId === undefined ? "" : " Also skipped your next queued message."}`
						: `Halted the in-progress reply.${queuedMessageId === undefined ? "" : " Also skipped your next queued message."}`,
				);
				return;
			}
			if ((queueDepth.get(chat) ?? 0) === 0) {
				await bot.api.sendMessage(ctx.chat.id, "Nothing is running.");
				return;
			}
			const queuedMessageId = queuedMessageIds.get(chat)?.[0];
			if (queuedMessageId === undefined) {
				await bot.api.sendMessage(ctx.chat.id, "Nothing is queued.");
				return;
			}
			requestStop(chat, queuedMessageId);
			await bot.api.sendMessage(ctx.chat.id, "Halted the queued message.");
			return;
		}

		const messageId = ctx.message.message_id;
		const queued = queuedMessageIds.get(chat) ?? [];
		queued.push(messageId);
		queuedMessageIds.set(chat, queued);
		queueDepth.set(chat, (queueDepth.get(chat) ?? 0) + 1);
		const previous = queues.get(chat) ?? Promise.resolve();
		const next = previous.then(async () => {
			removeQueuedMessage(chat, messageId);
			if (consumeStopRequest(chat, messageId)) return;
			const session = await sessionFor(chat, cwd, sessions);
			const images: string[] = [];
			// Fallback prompt for caption-less attachments: without it, an empty string
			// reaches the agent and the attachment is silently ignored (2026-09-08 fix).
			let attachmentNote: string | undefined;
			const noteFor = (name: string, mime: string, size: number, kind: string) =>
				`User sent a ${kind} without a caption: "${name}" (mime type ${mime}, ${size} bytes). ` +
				`It has been stored as a document artifact in this session. Use convert_doc to read it if needed, and respond about it.`;
			if (ctx.message.photo?.length) {
				const photo = ctx.message.photo.at(-1);
				if (photo) {
					const data = await downloadFile(bot, token, photo.file_id);
					images.push(`data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`);
					if (!messageText(ctx))
						attachmentNote = "User sent a photo without a caption. Describe or act on it as appropriate.";
				}
			} else if (ctx.message.document) {
				const document = ctx.message.document;
				const data = await downloadFile(bot, token, document.file_id);
				if (document.mime_type?.startsWith("image/")) {
					images.push(`data:${document.mime_type};base64,${Buffer.from(data).toString("base64")}`);
				} else {
					session.sessionManager.storeArtifact("telegram document", document.file_name ?? "document", data);
					if (!messageText(ctx))
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
				const media =
					ctx.message.audio ??
					ctx.message.video ??
					ctx.message.voice ??
					ctx.message.video_note ??
					ctx.message.animation;
				if (media?.file_id) {
					try {
						const data = await downloadFile(bot, token, media.file_id);
						const meta = media as { file_name?: string; mime_type?: string };
						const name = meta.file_name ?? meta.mime_type ?? "media";
						const mime = meta.mime_type ?? "unknown";
						session.sessionManager.storeArtifact("telegram document", name, data);
						if (!messageText(ctx)) attachmentNote = noteFor(name, mime, data.length, "media file");
					} catch (e) {
						console.error("Failed to download non-document media:", e);
					}
				}
			}

			let response: string | undefined;
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
						} else {
							await bot.api.editMessageText(ctx.chat.id, statusMessageId, text);
						}
					} catch {
						// Ignore transient status failures (e.g. "message not modified", rate limits).
					}
				});
			};

			const toolNames: string[] = [];
			const generatedImages: Buffer[] = [];
			const unsubscribe = session.subscribe((event) => {
				response = assistantText(event) ?? response;
				if (event.type === "tool_execution_start") {
					runningTool.set(chat, event.toolName);
					setStatus(`Running ${event.toolName}...`);
				}
				if (event.type === "tool_execution_end") {
					runningTool.delete(chat);
					toolNames.push(event.toolName);
					generatedImages.push(...extractGeneratedImages(event.result));
				}
			});
			const abortController = new AbortController();
			startTypingIndicator(bot, ctx.chat.id, abortController.signal);
			try {
				await session.prompt(messageText(ctx) || attachmentNote || "", {
					replyContext: replyText(ctx),
					images: images.length ? images : undefined,
					source: "extension",
				});
			} finally {
				unsubscribe();
				abortController.abort();
				runningTool.delete(chat);
			}
			await statusPending;
			if (haltedByStop.delete(chat)) {
				if (statusMessageId !== undefined)
					await bot.api.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
				return;
			}
			if (response) {
				await sendTelegramReply(bot, ctx.chat.id, response, toolNames, ctx.message.message_id, statusMessageId);
			} else if (statusMessageId !== undefined) {
				await bot.api.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
			}
			for (const image of generatedImages) {
				await bot.api.sendPhoto(ctx.chat.id, new InputFile(image));
			}

			const channelSessionKey = session.sessionManager.getChannelSessionKey();
			maybeRunConsolidation({
				cwd: session.sessionManager.getCwd(),
				channel: channelSessionKey.channel,
				channelSessionId: channelSessionKey.channelSessionId,
				userMessageText: messageText(ctx),
				mainSessionManager: session.sessionManager,
				modelRuntime: session.modelRuntime,
			});
		});
		queues.set(
			chat,
			next.catch(() => {}),
		);
		void next
			.finally(() => {
				const depth = (queueDepth.get(chat) ?? 1) - 1;
				if (depth > 0) queueDepth.set(chat, depth);
				else queueDepth.delete(chat);
			})
			.catch(() => {});
		await next;
	});

	return bot;
}

export async function runTelegramBot(options: TelegramBotOptions = {}): Promise<void> {
	const bot = createTelegramBot(options);
	await bot.start();
}

if (import.meta.main) await runTelegramBot();
