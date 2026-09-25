import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot, type Context, InputFile } from "grammy";
import type { Message } from "grammy/types";
import { type ChannelInput, configureHttpDispatcher, createChannelSessions, getAgentDir } from "theoses-coding-agent";
import { readInbound, resolvePrompt } from "./inbound.ts";
import { createTurnQueue } from "./turn-queue.ts";
import { createTurnView, type Outbox } from "./turn-view.ts";

// No settings.json override plumbing here (telegram doesn't load SettingsManager);
// this applies the shared default idle timeout globally so a stalled/looping
// provider stream is abandoned and retried well before OpenRouter's own
// much longer upstream timeout.
configureHttpDispatcher();

const CHANNEL = "telegram";
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 120_000;
const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
// Telegram's typing indicator expires after ~5s, so it must be re-sent. 3s leaves room for a late timer
// or a slow API call before it lapses.
const TYPING_INTERVAL_MS = 3000;
/** How long an album leader waits for the rest of the group; Telegram gives no "album complete" signal. */
const ALBUM_WAIT_MS = 1000;
const TYPING_FAILURE_LOG_INTERVAL_MS = 30_000;
/**
 * A turn that still ends in a provider error after the session's own retries gets one automatic
 * follow-up after this delay - the same "Proceed" the owner otherwise had to type by hand (2026-09-24:
 * four Xiaomi stream timeouts left a PR task idle for 9 minutes). Any owner message cancels it.
 */
const AUTO_RESUME_DELAY_MS = 60_000;
/**
 * The resume turn's prompt. Its settlementText is "": Turn Settlement (memory consolidation, task-boundary
 * detection) only ever judges what the owner wrote, never the harness's own words.
 */
const AUTO_RESUME_INPUT: ChannelInput = {
	text: "[automatic resume] Your previous turn stopped on a provider error before finishing. Continue the task from where you left off.",
	settlementText: "",
};

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

/**
 * The grammy adapter for a Turn View's Outbox. Rich messages go through `bot.api.raw` (see
 * RawApiWithRichMessage). `afterSend` runs after every new message: Telegram drops the typing status
 * the moment the bot sends one.
 */
function grammyOutbox(bot: Bot, chat: number, afterSend: () => void): Outbox {
	const rawApi = bot.api.raw as unknown as RawApiWithRichMessage;
	return {
		async send(text, format, replyTo) {
			const reply_parameters = replyTo ? { message_id: replyTo } : undefined;
			const sent =
				format === "rich"
					? await rawApi.sendRichMessage({ chat_id: chat, rich_message: { markdown: text }, reply_parameters })
					: await bot.api.sendMessage(chat, text, {
							...(format === "html" ? { parse_mode: "HTML" as const } : {}),
							reply_parameters,
						});
			afterSend();
			return sent.message_id;
		},
		async edit(messageId, text, format) {
			if (format === "rich") {
				await rawApi.editMessageText({ chat_id: chat, message_id: messageId, rich_message: { markdown: text } });
			} else if (format === "html") {
				await bot.api.editMessageText(chat, messageId, text, { parse_mode: "HTML" });
			} else {
				await bot.api.editMessageText(chat, messageId, text);
			}
		},
		async delete(messageId) {
			await bot.api.deleteMessage(chat, messageId);
		},
		// Issue #198: several images from one turn (e.g. repeated generate_image calls) go out as one album.
		async sendPhotos(images) {
			if (images.length > 1) {
				await bot.api.sendMediaGroup(
					chat,
					images.map((image) => ({ type: "photo" as const, media: new InputFile(image) })),
				);
			} else if (images.length === 1) {
				await bot.api.sendPhoto(chat, new InputFile(images[0]));
			}
			afterSend();
		},
	};
}

export interface TelegramBotOptions {
	token?: string;
	ownerChatId?: string;
	cwd?: string;
}

/** A queued turn: the owner's message (or album), or the one automatic resume after a failed turn. */
type TurnRequest = { kind: "message"; album: Message[]; albumKey?: string } | { kind: "resume" };

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
	const albums = new Map<string, Message[]>();
	// Queue scheduling, /stop targeting and auto-resume - see turn-queue.ts.
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

	/**
	 * Queues one turn for `chat`, threaded to `replyTo`. Not awaited by the update handler (issue #209):
	 * grammY dispatches updates strictly sequentially, so awaiting a turn - which can run for minutes on a
	 * long tool call - made every later update, including the /stop meant to interrupt it, undeliverable
	 * until it ended. Turns stay ordered per chat through turnQueue's own chain.
	 */
	const queueTurn = (chat: string, id: number, replyTo: number, request: TurnRequest): void => {
		const releaseTyping = acquireTyping(chat, id);
		turnQueue.trackDepth(chat);
		const next = turnQueue.enqueue(chat, replyTo, async () => {
			// Album leader: wait for the rest of the group inside the queued job, not in the update handler,
			// which grammy must keep free to deliver the rest of the album.
			if (request.kind === "message" && request.albumKey) {
				await new Promise((resolve) => setTimeout(resolve, ALBUM_WAIT_MS));
				albums.delete(request.albumKey);
			}
			turnQueue.dequeue(chat, replyTo);
			if (turnQueue.consumeStopRequest(chat, replyTo)) return;
			const session = await channelSessions.open(chat);

			const inbound = request.kind === "message" ? readInbound(request.album[0]) : undefined;
			if (inbound?.kind === "model") {
				let reply: string;
				if (inbound.ref) {
					const switched = await session.switchModel(inbound.ref);
					reply = "error" in switched ? switched.error : `Model: ${switched.model.provider}/${switched.model.id}`;
				} else {
					const current = session.model;
					reply = current
						? `Current model: ${current.provider}/${current.id}\nSwitch with: /model <provider/id>`
						: "No model set yet.\nSwitch with: /model <provider/id>";
				}
				await bot.api.sendMessage(id, reply);
				return;
			}

			const input =
				request.kind === "resume"
					? AUTO_RESUME_INPUT
					: await resolvePrompt(request.album, {
							download: (fileId) => downloadFile(bot, token, fileId),
							storeArtifact: (label, fileName, data) => session.storeArtifact(label, fileName, data),
						});
			const view = createTurnView(
				grammyOutbox(bot, id, () => refreshTyping(chat, id)),
				{ replyTo, toolCallDetail: toolCallDetailEnabled },
			);
			let result: Awaited<ReturnType<typeof session.submit>>;
			try {
				result = await session.submit(input, view.onEvent);
			} finally {
				releaseTyping();
			}
			// Capped at one: a resume that fails again is reported and left for the owner.
			const autoResume = result?.finalError !== undefined && request.kind !== "resume";
			await view.finish(result, { resumeInMs: autoResume ? AUTO_RESUME_DELAY_MS : undefined });
			if (autoResume) {
				// Goes through the normal queue, typing, status, /stop and reply handling, threaded to the
				// message that started the failed task.
				turnQueue.scheduleAutoResume(
					chat,
					() => queueTurn(chat, id, replyTo, { kind: "resume" }),
					AUTO_RESUME_DELAY_MS,
				);
			}
		});
		void next
			.finally(() => {
				// Also covers turns that never reach the prompt: skipped by /stop, /model, or a failure.
				releaseTyping();
				turnQueue.untrackDepth(chat);
			})
			.catch(() => {});
	};

	bot.on("message", async (ctx) => {
		const chat = chatId(ctx);
		if (chat !== ownerChatId || !ctx.message) return;

		// Any new owner message supersedes a scheduled auto-resume: it either continues the task itself or redirects it.
		const cancelledResume = turnQueue.cancelAutoResume(chat);

		const inbound = readInbound(ctx.message);
		if (inbound.kind === "stop") {
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

		if (inbound.kind === "toolCallDetail") {
			toolCallDetailEnabled = inbound.on;
			saveToolCallDetailPreference(inbound.on);
			await bot.api.sendMessage(
				ctx.chat.id,
				inbound.on
					? "Tool call detail: on. Each tool call now shows as its own one-line status entry (name + command preview, no raw output)."
					: "Tool call detail: off. Back to the compact tool-name footer.",
			);
			return;
		}

		// Telegram delivers an album as separate messages sharing a media_group_id. The first one
		// becomes the leader and handles them all as a single turn; the others just join its list.
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
		queueTurn(chat, ctx.chat.id, ctx.message.message_id, { kind: "message", album, albumKey });
	});

	return bot;
}

export async function runTelegramBot(options: TelegramBotOptions = {}): Promise<void> {
	const bot = createTelegramBot(options);
	await bot.start();
}

if (import.meta.main) await runTelegramBot();
