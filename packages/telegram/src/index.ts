import { Bot, type Context } from "grammy";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type SessionInfo,
	SessionManager,
} from "theoses-coding-agent";

const CHANNEL = "telegram";

function chatId(ctx: Context): string | undefined {
	return ctx.chat?.id.toString();
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

async function downloadFile(bot: Bot, token: string, fileId: string): Promise<Uint8Array> {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) throw new Error("Telegram file has no download path");
	const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
	if (!response.ok) throw new Error(`Telegram file download returned HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
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
			? SessionManager.open(matches[0].path)
			: SessionManager.create(cwd, undefined, key);
		const { session } = await createAgentSession({ sessionManager });
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
	const cwd = options.cwd ?? process.cwd();
	const sessions = new Map<string, Promise<AgentSession>>();
	const queues = new Map<string, Promise<void>>();

	bot.on("message", async (ctx) => {
		const chat = chatId(ctx);
		if (chat !== ownerChatId || !ctx.message) return;
		const previous = queues.get(chat) ?? Promise.resolve();
		const next = previous.then(async () => {
			const session = await sessionFor(chat, cwd, sessions);
			const images: string[] = [];
			if (ctx.message.photo?.length) {
				const photo = ctx.message.photo.at(-1);
				if (photo) {
					const data = await downloadFile(bot, token, photo.file_id);
					images.push(`data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`);
				}
			} else if (ctx.message.document) {
				const document = ctx.message.document;
				const data = await downloadFile(bot, token, document.file_id);
				if (document.mime_type?.startsWith("image/")) {
					images.push(`data:${document.mime_type};base64,${Buffer.from(data).toString("base64")}`);
				} else {
					session.sessionManager.storeArtifact("telegram document", document.file_name ?? "document", data);
				}
			}

			let response: string | undefined;
			const unsubscribe = session.subscribe((event) => {
				response = assistantText(event) ?? response;
			});
			try {
				await session.prompt(messageText(ctx), {
					replyContext: replyText(ctx),
					images: images.length ? images : undefined,
					source: "extension",
				});
			} finally {
				unsubscribe();
			}
			if (response) await ctx.reply(response);
		});
		queues.set(
			chat,
			next.catch(() => {}),
		);
		await next;
	});

	return bot;
}

export async function runTelegramBot(options: TelegramBotOptions = {}): Promise<void> {
	const bot = createTelegramBot(options);
	await bot.start();
}

if (import.meta.main) await runTelegramBot();
