import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile as readAsset } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "theoses-agent-core";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	maybeRunConsolidation,
	type SessionInfo,
	SessionManager,
} from "theoses-coding-agent";
import { deletePath, FileConflictError, listDirectory, readTextFile, renamePath, writeTextFile } from "./files.ts";
import { readMemoryGraph } from "./memory-graph.ts";
import { saveTelegramConfig, telegramConfigStatus } from "./telegram-config.ts";

const DASHBOARD_CHANNEL = "dashboard";
const TELEGRAM_CHANNEL = "telegram";
const DASHBOARD_TOKEN_COOKIE = "theoses_dashboard_token";
const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));

interface DashboardSession {
	manager: SessionManager;
	session: AgentSession;
	queue: Promise<void>;
}

export interface DashboardServerOptions {
	cwd?: string;
	host?: string;
	port?: number;
	accessToken?: string;
	telegramConfigPath?: string;
}

interface SessionView {
	id: string;
	channel: string;
	title: string;
	modified: string;
	messageCount: number;
	path: string;
}

const sessions = new Map<string, Promise<DashboardSession>>();

function tokenMatches(candidate: string, expected: string): boolean {
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(expected);
	return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function cookieValue(header: string | undefined): string | undefined {
	for (const item of header?.split(";") ?? []) {
		const [name, ...parts] = item.trim().split("=");
		if (name !== DASHBOARD_TOKEN_COOKIE) continue;
		try {
			return decodeURIComponent(parts.join("="));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function requestToken(request: IncomingMessage): string | undefined {
	const authorization = request.headers.authorization;
	const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	return bearer ?? cookieValue(request.headers.cookie);
}

function requireAccess(request: IncomingMessage, response: ServerResponse, accessToken: string): boolean {
	if (!accessToken) {
		json(response, 503, { error: "Dashboard access token is not configured" });
		return false;
	}
	if (tokenMatches(requestToken(request) ?? "", accessToken)) return true;
	response.setHeader("WWW-Authenticate", 'Bearer realm="Theoses dashboard"');
	json(response, 401, { error: "Dashboard authentication required" });
	return false;
}

async function login(request: IncomingMessage, response: ServerResponse, accessToken: string): Promise<void> {
	if (request.method !== "POST") {
		json(response, 405, { error: "POST only" });
		return;
	}
	if (!accessToken) {
		json(response, 503, { error: "Dashboard access token is not configured" });
		return;
	}
	const supplied = stringField(await body(request), "token");
	if (!tokenMatches(supplied, accessToken)) {
		response.setHeader("WWW-Authenticate", 'Bearer realm="Theoses dashboard"');
		json(response, 401, { error: "Invalid dashboard token" });
		return;
	}
	const secure = request.headers["x-forwarded-proto"] === "https";
	// Without Max-Age this is a session cookie: browsers drop it on their own
	// schedule (tab/process restart), forcing a re-login unrelated to whether the
	// token is still valid. One year keeps sign-in persistent like a normal app.
	const flags = `Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
	response.setHeader("Set-Cookie", `${DASHBOARD_TOKEN_COOKIE}=${encodeURIComponent(accessToken)}; ${flags}`);
	json(response, 200, { ok: true });
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function stringField(value: unknown, name: string): string {
	if (typeof value !== "object" || value === null) throw new Error(`${name} is required`);
	const record = value as Record<string, unknown>;
	if (typeof record[name] !== "string") {
		throw new Error(`${name} is required`);
	}
	return record[name];
}

function optionalStringField(value: unknown, name: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record[name] === "string" ? record[name] : undefined;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

type HistorySegment =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; result: string; isError: boolean };

interface UsageSummary {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
}

interface HistoryTurn {
	role: "user" | "assistant";
	segments: HistorySegment[];
	usage?: UsageSummary;
}

function usageSummary(usage: {
	input: number;
	output: number;
	totalTokens: number;
	cost: { total: number };
}): UsageSummary {
	return { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost.total };
}

function sessionHistory(manager: SessionManager): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const entry of manager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			turns.push({ role: "user", segments: [{ type: "text", text: messageText(message) }] });
			continue;
		}
		if (message.role === "assistant") {
			const segments: HistorySegment[] = [];
			for (const part of message.content) {
				if (part.type === "text") segments.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					segments.push({ type: "tool_call", id: part.id, name: part.name, args: part.arguments });
			}
			turns.push({ role: "assistant", segments, usage: usageSummary(message.usage) });
			continue;
		}
		if (message.role === "toolResult") {
			const segment: HistorySegment = {
				type: "tool_result",
				id: message.toolCallId,
				name: message.toolName,
				result: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(""),
				isError: message.isError,
			};
			const last = turns.at(-1);
			if (last?.role === "assistant") last.segments.push(segment);
			else turns.push({ role: "assistant", segments: [segment] });
		}
	}
	return turns;
}

function sessionView(info: SessionInfo): SessionView {
	return {
		id: info.id,
		channel: info.channel ?? "cli",
		title: info.name ?? (info.firstMessage.slice(0, 80) || info.id),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		path: info.path,
	};
}

async function visibleSessions(): Promise<SessionView[]> {
	const infos = await SessionManager.listAll();
	return infos
		.filter((info) => info.channel === DASHBOARD_CHANNEL || info.channel === TELEGRAM_CHANNEL)
		.sort((left, right) => right.modified.getTime() - left.modified.getTime())
		.map(sessionView);
}

async function findVisibleSession(id: string): Promise<SessionInfo> {
	const info = (await SessionManager.listAll()).find(
		(session) => session.id === id && (session.channel === DASHBOARD_CHANNEL || session.channel === TELEGRAM_CHANNEL),
	);
	if (info) return info;

	// Not on disk yet: SessionManager only flushes a session file once it has an
	// assistant message, so a brand-new session lives only in the in-memory map.
	for (const [path, pending] of sessions) {
		const record = await pending;
		if (record.manager.getSessionId() !== id) continue;
		const key = record.manager.getChannelSessionKey();
		if (key.channel !== DASHBOARD_CHANNEL) continue;
		return {
			path,
			id,
			cwd: record.manager.getCwd(),
			channel: key.channel,
			channelSessionId: key.channelSessionId,
			created: new Date(),
			modified: new Date(),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
	}
	throw new Error("Session not found");
}

async function dashboardSession(path: string): Promise<DashboardSession> {
	const existing = sessions.get(path);
	if (existing) return existing;
	const created = (async () => {
		const manager = SessionManager.open(path);
		if (manager.getChannelSessionKey().channel !== DASHBOARD_CHANNEL) throw new Error("Session is read-only");
		const { session } = await createAgentSession({ sessionManager: manager });
		return { manager, session, queue: Promise.resolve() };
	})();
	sessions.set(path, created);
	return created;
}

function setQueue(record: DashboardSession, work: Promise<void>): void {
	record.queue = work.catch(() => {});
}

async function newDashboardSession(cwd: string): Promise<SessionView> {
	const id = randomUUID();
	const manager = SessionManager.create(cwd, undefined, {
		id,
		channel: DASHBOARD_CHANNEL,
		channelSessionId: id,
	});
	const { session } = await createAgentSession({ sessionManager: manager });
	const path = manager.getSessionFile();
	if (!path) throw new Error("Dashboard session was not persisted");
	sessions.set(path, Promise.resolve({ manager, session, queue: Promise.resolve() }));
	return {
		id,
		channel: DASHBOARD_CHANNEL,
		title: id,
		modified: new Date().toISOString(),
		messageCount: 0,
		path,
	};
}

function sseSend(response: ServerResponse, event: string, data: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		return (result as { content: Array<{ type: string; text?: string }> }).content
			.map((part) => (part.type === "text" ? (part.text ?? "") : "[image]"))
			.join("");
	}
	return JSON.stringify(result);
}

async function streamChat(info: SessionInfo, request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (info.channel !== DASHBOARD_CHANNEL) throw new Error("Telegram sessions are read-only");
	const record = await dashboardSession(info.path);
	const input = await body(request);
	const message = stringField(input, "message").trim();
	if (!message) throw new Error("message is required");
	const replyContext = optionalStringField(input, "replyContext");

	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-store",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const work = record.queue.then(async () => {
		const unsubscribe = record.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_update" && event.message.role === "assistant") {
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta") sseSend(response, "delta", { text: delta.delta });
			} else if (event.type === "tool_execution_start") {
				sseSend(response, "tool_call", { id: event.toolCallId, name: event.toolName, args: event.args });
			} else if (event.type === "tool_execution_end") {
				sseSend(response, "tool_result", {
					id: event.toolCallId,
					name: event.toolName,
					result: toolResultText(event.result),
					isError: event.isError,
				});
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				sseSend(response, "usage", usageSummary(event.message.usage));
			}
		});
		try {
			await record.session.prompt(message, { replyContext, source: "interactive" });
		} finally {
			unsubscribe();
		}
	});
	setQueue(record, work);
	try {
		await work;
		sseSend(response, "done", {});
		const channelSessionKey = record.session.sessionManager.getChannelSessionKey();
		maybeRunConsolidation({
			cwd: record.session.sessionManager.getCwd(),
			channel: channelSessionKey.channel,
			channelSessionId: channelSessionKey.channelSessionId,
			userMessageText: message,
			mainSessionManager: record.session.sessionManager,
			modelRuntime: record.session.modelRuntime,
		});
	} catch (error) {
		sseSend(response, "error", { message: error instanceof Error ? error.message : String(error) });
	} finally {
		response.end();
	}
}

async function stopChat(info: SessionInfo): Promise<void> {
	if (info.channel !== DASHBOARD_CHANNEL) throw new Error("Telegram sessions are read-only");
	const record = await dashboardSession(info.path);
	await record.session.abort();
}

function errorStatus(error: unknown): number {
	if (error instanceof FileConflictError) return 409;
	if (error instanceof Error && "code" in error) {
		const code = error.code;
		if (code === "ENOENT") return 404;
		if (code === "EACCES" || code === "EPERM") return 403;
	}
	return 400;
}

async function api(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	cwd: string,
	telegramConfigPath: string,
): Promise<boolean> {
	if (url.pathname === "/api/telegram" && request.method === "GET") {
		json(response, 200, await telegramConfigStatus(telegramConfigPath));
		return true;
	}
	if (url.pathname === "/api/telegram" && request.method === "POST") {
		const input = await body(request);
		if (typeof input !== "object" || input === null) throw new Error("settings object is required");
		const values = input as Record<string, unknown>;
		await saveTelegramConfig(telegramConfigPath, {
			botToken: typeof values.botToken === "string" ? values.botToken : undefined,
			ownerTelegramId: typeof values.ownerTelegramId === "string" ? values.ownerTelegramId : undefined,
		});
		json(response, 200, { ok: true, restartRequired: true });
		return true;
	}
	if (url.pathname === "/api/sessions" && request.method === "GET") {
		json(response, 200, { sessions: await visibleSessions() });
		return true;
	}
	if (url.pathname === "/api/sessions" && request.method === "POST") {
		json(response, 201, await newDashboardSession(cwd));
		return true;
	}

	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|stop))?$/);
	if (sessionMatch) {
		const id = decodeURIComponent(sessionMatch[1]);
		const info = await findVisibleSession(id);
		if (sessionMatch[2] === "messages" && request.method === "POST") {
			await streamChat(info, request, response);
			return true;
		}
		if (sessionMatch[2] === "stop" && request.method === "POST") {
			await stopChat(info);
			json(response, 200, { ok: true });
			return true;
		}
		if (request.method === "GET") {
			const manager = SessionManager.open(info.path);
			json(response, 200, { session: sessionView(info), history: sessionHistory(manager) });
			return true;
		}
	}

	if (url.pathname === "/api/files" && request.method === "GET") {
		const requestedPath = url.searchParams.get("path") ?? "/";
		json(response, 200, { path: resolve(requestedPath), entries: await listDirectory(requestedPath) });
		return true;
	}
	if (url.pathname === "/api/file" && request.method === "GET") {
		json(response, 200, await readTextFile(stringField({ path: url.searchParams.get("path") }, "path")));
		return true;
	}
	if (url.pathname === "/api/file" && request.method === "PUT") {
		const input = await body(request);
		json(
			response,
			200,
			await writeTextFile(stringField(input, "path"), stringField(input, "content"), stringField(input, "version")),
		);
		return true;
	}
	if (url.pathname === "/api/file" && request.method === "DELETE") {
		json(response, 200, await deletePath(stringField({ path: url.searchParams.get("path") }, "path")));
		return true;
	}
	if (url.pathname === "/api/rename" && request.method === "POST") {
		const input = await body(request);
		json(response, 200, await renamePath(stringField(input, "path"), stringField(input, "newName")));
		return true;
	}
	if (url.pathname === "/api/memory-graph" && request.method === "GET") {
		json(response, 200, await readMemoryGraph());
		return true;
	}
	return false;
}

async function asset(response: ServerResponse, pathname: string): Promise<void> {
	const name = pathname === "/" ? "index.html" : pathname.slice(1);
	if (name !== "index.html" && name !== "app.js" && name !== "style.css") {
		response.writeHead(404).end();
		return;
	}
	const types: Record<string, string> = {
		"index.html": "text/html; charset=utf-8",
		"app.js": "text/javascript; charset=utf-8",
		"style.css": "text/css; charset=utf-8",
	};
	response.writeHead(200, { "Content-Type": types[name] });
	response.end(await readAsset(join(publicDirectory, name)));
}

export function createDashboardServer(options: DashboardServerOptions = {}) {
	// Deployments that run the dashboard from a versioned release directory (e.g. a `current`
	// symlink swapped on each release) must set THEOSES_DASHBOARD_CWD to a stable path.
	// process.cwd() resolves through such a symlink to the release's real physical path, which
	// changes every release — the same bug fixed for the Telegram bot's THEOSES_TELEGRAM_CWD.
	const cwd = options.cwd ?? process.env.THEOSES_DASHBOARD_CWD ?? process.cwd();
	const accessToken = options.accessToken ?? process.env.THEOSES_DASHBOARD_TOKEN ?? "";
	const telegramConfigPath = options.telegramConfigPath ?? join(getAgentDir(), "theoses.env");
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname.startsWith("/api/")) {
				if (url.pathname === "/api/login") {
					await login(request, response, accessToken);
					return;
				}
				if (!requireAccess(request, response, accessToken)) return;
				if (await api(request, response, url, cwd, telegramConfigPath)) return;
				json(response, 404, { error: "Not found" });
				return;
			}
			if (request.method !== "GET") {
				json(response, 405, { error: "Method not allowed" });
				return;
			}
			await asset(response, url.pathname);
		} catch (error) {
			json(response, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		}
	});
}

export async function runDashboard(options: DashboardServerOptions = {}): Promise<void> {
	const server = createDashboardServer(options);
	const host = options.host ?? process.env.THEOSES_DASHBOARD_HOST ?? "127.0.0.1";
	const port = options.port ?? Number(process.env.THEOSES_DASHBOARD_PORT ?? 7788);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	console.log(`Theoses dashboard listening on http://${host}:${port}`);
	await new Promise<void>(() => {});
}

if (import.meta.main) await runDashboard();
