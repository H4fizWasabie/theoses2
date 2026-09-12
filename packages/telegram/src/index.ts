import { Bot, type Context, InputFile } from "grammy";
import {
	type AgentSession,
	type AgentSessionEvent,
	configureHttpDispatcher,
	createAgentSession,
	DefaultResourceLoader,
	findExactModelReferenceMatch,
	findLastUserMessageEntryId,
	getAgentDir,
	maybeDetectTaskBoundary,
	maybeRunConsolidation,
	type SessionInfo,
	SessionManager,
} from "theoses-coding-agent";
import { chunkHtml, formatTelegramHtml, splitSections } from "./format.ts";

// No settings.json override plumbing here (telegram doesn't load SettingsManager);
// this applies the shared default idle timeout globally so a stalled/looping
// provider stream is abandoned and retried well before OpenRouter's own
// much longer upstream timeout.
configureHttpDispatcher();

const CHANNEL = "telegram";
const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 120_000;
const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_STOP_REQUEST_TTL_MS = 30_000;
const TYPING_INTERVAL_MS = 4000; // Telegram's typing indicator expires after ~5s, so it must be re-sent.
// Bot API's own documented ceiling for a rich message's text (headings/bold/tables/etc combined).
const RICH_MESSAGE_CHAR_LIMIT = 32768;

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
		// No `tools:` allowlist here (unlike an earlier version of this code): passing one sets
		// both the active set AND a hard gate that filters extension-registered tools out of the
		// registry entirely (agent-session.ts's isAllowedTool), regardless of session age or
		// process restarts - that's what silently kept every extension's tools (e.g. procura's
		// four) off Telegram no matter how the extension or session were refreshed. Leaving it
		// unset matches the dashboard channel: full SDK default tools plus every extension tool.
		//
		// A custom resourceLoader (issues #195/#196) appends Telegram-only rich-formatting
		// guidance - collapsible blocks and footnotes have no existing habit to build on, unlike
		// headings/quotes, so they need explicit guidance. Channel-scoped deliberately: this cwd
		// is Telegram-specific, so it never reaches the dashboard or CLI, which don't render rich
		// messages the same way.
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			appendSystemPrompt: [TELEGRAM_RICH_FORMATTING_GUIDANCE],
		});
		const { session } = await createAgentSession({ sessionManager, thinkingLevel: "high", resourceLoader });
		// Telegram document uploads are stored as artifacts (see the `ctx.message.document` branch
		// below) and need convert_doc enabled to ever be read. Guard against it already being in
		// the default active set (it is, as of the SDK's current defaults) - blindly appending it
		// produced a duplicate `convert_doc` entry in the tools array sent on every request, which
		// OpenRouter's Novita backend rejects outright as an invalid request (400) and DeepInfra
		// silently declines to serve (404, filtered out at the routing layer) - see issue #211.
		const activeToolNames = session.getActiveToolNames();
		if (!activeToolNames.includes("convert_doc")) {
			session.setActiveToolsByName([...activeToolNames, "convert_doc"]);
		}
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
				const match = findExactModelReferenceMatch(modelArg, [...session.modelRuntime.getAvailableSnapshot()]);
				if (!match) {
					await bot.api.sendMessage(
						ctx.chat.id,
						`No exact match for "${modelArg}". Use the canonical provider/id (e.g. deepseek/deepseek-v4.1-flash).`,
					);
					return;
				}
				try {
					// Session-only switch (mirrors the CLI TUI's `/model` default of persist: false) -
					// this changes what this Telegram conversation uses going forward, not the global
					// default in settings.json (which only seeds brand-new sessions).
					await session.setModel(match, { persist: false });
					await bot.api.sendMessage(ctx.chat.id, `Model: ${match.provider}/${match.id}`);
				} catch (error) {
					await bot.api.sendMessage(
						ctx.chat.id,
						`Couldn't switch model: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}

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

			const channelSessionKey = session.sessionManager.getChannelSessionKey();
			maybeRunConsolidation({
				cwd: session.sessionManager.getCwd(),
				channel: channelSessionKey.channel,
				channelSessionId: channelSessionKey.channelSessionId,
				userMessageText: messageText(ctx),
				mainSessionManager: session.sessionManager,
				modelRuntime: session.modelRuntime,
			});
			// Issue #186, shadow mode: task-closure/topic-shift detection, separate from
			// consolidation's phrase-trigger above — see task-boundary-detector.ts.
			const lastUserEntryId = findLastUserMessageEntryId(session.sessionManager.getBranch());
			if (lastUserEntryId) {
				maybeDetectTaskBoundary({
					channel: channelSessionKey.channel,
					channelSessionId: channelSessionKey.channelSessionId,
					userMessageText: messageText(ctx),
					userMessageEntryId: lastUserEntryId,
					mainSessionManager: session.sessionManager,
					modelRuntime: session.modelRuntime,
				});
			}
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
