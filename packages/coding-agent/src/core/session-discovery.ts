import {
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import type { AgentMessage } from "theoses-agent-core";
import type { Message, TextContent } from "theoses-ai";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { type SessionLookupKey, sessionLookupKey } from "./session-cwd.ts";
import type {
	CustomEntry,
	FileEntry,
	SessionHeader,
	SessionInfo,
	SessionMessageEntry,
	SessionRotatedData,
} from "./session-manager.ts";

export const SESSION_ROTATED_ENTRY_TYPE = "session_rotated";

/** The entry Log Rotation ends a closed log with, naming the log that continues it. */
export function isRotationMarker(entry: FileEntry | null | undefined): entry is CustomEntry<SessionRotatedData> {
	return entry?.type === "custom" && entry.customType === SESSION_ROTATED_ENTRY_TYPE;
}

const NEWLINE = 0x0a;
/** \n, \r, space and tab, trimmed from the end of the file before its last record. */
const TRAILING_WHITESPACE = [NEWLINE, 0x0d, 0x20, 0x09];

/** Reads only the last physical record, including records larger than a read buffer. */
function lastEntry(filePath: string): FileEntry | null {
	const fd = openSync(filePath, "r");
	try {
		let position = statSync(filePath).size;
		const chunks: Buffer[] = [];
		while (position > 0) {
			const length = Math.min(position, 4096);
			position -= length;
			const chunk = Buffer.allocUnsafe(length);
			readSync(fd, chunk, 0, length, position);
			let end = chunk.length;
			if (chunks.length === 0) while (end > 0 && TRAILING_WHITESPACE.includes(chunk[end - 1])) end--;
			if (end === 0) {
				continue;
			}
			const start = chunk.lastIndexOf(NEWLINE, end - 1) + 1;
			chunks.push(chunk.subarray(start, end));
			if (start > 0 || position === 0)
				return parseSessionEntryLine(Buffer.concat(chunks.reverse()).toString("utf8"));
		}
		return null;
	} finally {
		closeSync(fd);
	}
}

/** A closed log cannot become writable again, even if its successor has disappeared. */
export function assertSessionWritable(filePath: string): void {
	if (!existsSync(filePath)) return;
	if (isRotationMarker(lastEntry(filePath))) {
		throw new Error(`Cannot write to a log closed by Log Rotation: ${filePath}`);
	}
}

function rotationHeader(path: string): SessionHeader | null {
	try {
		return readSessionHeader(path);
	} catch (error) {
		if (!(error instanceof SessionHeaderScanLimitError)) throw error;
		const first = loadEntriesFromFile(path)[0];
		return first?.type === "session" ? first : null;
	}
}

/** The one definition of a rotation link: forward and backward walks both follow it. */
function rotationSuccessor(path: string): string | undefined {
	const entry = lastEntry(path);
	if (!isRotationMarker(entry)) return undefined;
	const to: unknown = entry.data?.to;
	const successor = typeof to === "string" && to ? resolvePath(to) : undefined;
	if (!successor || !existsSync(successor)) throw new Error(`Broken Log Rotation chain: missing successor of ${path}`);
	let source: SessionHeader | null;
	let header: SessionHeader | null;
	try {
		source = rotationHeader(path);
		header = rotationHeader(successor);
	} catch (error) {
		throw new Error(`Broken Log Rotation chain: unreadable successor ${successor}`, { cause: error });
	}
	if (
		!source ||
		typeof header?.parentSession !== "string" ||
		!existsSync(header.parentSession) ||
		realpathSync(header.parentSession) !== realpathSync(path) ||
		header.id === source.id ||
		header.channel !== source.channel ||
		header.channelSessionId !== source.channelSessionId ||
		(source.cwd !== undefined && header.cwd !== source.cwd)
	) {
		throw new Error(`Broken Log Rotation chain: invalid successor ${successor}`);
	}
	return successor;
}

/** Each existing log from `start`, following `next` until it names none; a log reached twice is a broken chain. */
function* rotationChain(start: string, next: (path: string) => string | undefined): Generator<string> {
	const visited = new Set<string>();
	for (let current: string | undefined = start; current && existsSync(current); current = next(current)) {
		const identity = realpathSync(current);
		if (visited.has(identity)) throw new Error(`Broken Log Rotation chain: cycle at ${current}`);
		visited.add(identity);
		yield current;
	}
}

/** Normal empty/missing paths keep open()'s creation behavior; successors never do. */
export function resolveSessionFile(filePath: string): string {
	let current = resolvePath(filePath);
	for (const path of rotationChain(current, rotationSuccessor)) current = path;
	return current;
}

/** The closed log `path` continues: its parent, only when the parent's rotation marker names `path`. Forks and
 * branches name a parent too, and that parent's turns belong to another session. */
function rotationPredecessor(path: string): string | undefined {
	const parent = rotationHeader(path)?.parentSession;
	if (!parent || !existsSync(parent)) return undefined;
	const successor = rotationSuccessor(parent);
	return successor && realpathSync(successor) === realpathSync(path) ? parent : undefined;
}

/** This log, then the closed logs of its session before it, newest first. A damaged link ends the walk, so one
 * damaged chain cannot break lookup of other sessions. */
export function* sessionLogsBack(sessionFile: string): Generator<string> {
	try {
		yield* rotationChain(resolvePath(sessionFile), rotationPredecessor);
	} catch {
		// Damaged link or cycle: the session's history ends here.
	}
}
function sessionFiles(sessionDir?: string): string[] {
	try {
		const dirs = sessionDir
			? [normalizePath(sessionDir)]
			: readdirSync(getSessionsDir(), { withFileTypes: true })
					.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
					.map((entry) => join(getSessionsDir(), entry.name));
		return dirs.flatMap((dir) => {
			try {
				return readdirSync(dir)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => join(dir, name));
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

/** ID lookup includes predecessor logs even though normal lists hide them. */
export async function findSessionById(
	id: string,
	options: {
		cwd?: string;
		sessionDir?: string;
		channel?: string;
		prefix?: boolean;
		/** False reads the matching log itself, even a closed log, instead of its session's current log. */
		followRotation?: boolean;
	} = {},
): Promise<SessionInfo | undefined> {
	const { cwd, sessionDir, channel, prefix, followRotation = true } = options;
	const directory = sessionDir ?? (cwd ? getDefaultSessionDirPath(cwd) : undefined);
	const files = sessionFiles(directory).filter((path) => {
		const header = readSessionHeaderForDiscovery(path);
		return (
			header !== null &&
			(header.id === id || (prefix && header.id.startsWith(id))) &&
			(channel === undefined || header.channel === channel) &&
			(cwd === undefined ||
				(sessionKeyMatches(header, { channel: "cli", channelSessionId: resolvePath(cwd) }) &&
					(directory === getDefaultSessionDirPath(cwd) ||
						sessionCwdMatches(getSessionHeaderCwd(header), resolvePath(cwd)))))
		);
	});
	const matches = (
		await Promise.all(files.map((path) => buildSessionInfo(path, { channel, includeClosedLogs: true })))
	)
		.filter((info): info is SessionInfo => info !== null)
		.sort(byRecency);
	const exact = matches.find((info) => info.id === id);
	// A prefix may name one chain's logs (one session), but a read that does not follow rotation targets one log. A
	// broken chain counts as its own session and reports its error when selected.
	const targets = new Set(
		matches.map((info) => {
			if (!followRotation) return info.path;
			try {
				return resolveSessionFile(info.path);
			} catch {
				return info.path;
			}
		}),
	);
	if (!exact && targets.size > 1) throw new Error(`Session ID prefix '${id}' is ambiguous: ${targets.size} matches`);
	const match = exact ?? matches[0];
	if (!match || !followRotation) return match;
	const current = resolveSessionFile(match.path);
	const info = await buildSessionInfo(current, { channel, includeClosedLogs: true });
	if (!info) throw new Error(`Broken Log Rotation chain: invalid current log ${current}`);
	return info;
}

/** Matches an old engine ID against this live log's actual rotation predecessors, never fork parents. */
export function sessionIdMatches(id: string, sessionFile: string): boolean {
	try {
		for (const path of sessionLogsBack(sessionFile)) if (rotationHeader(path)?.id === id) return true;
	} catch {
		// An unreadable header is no match.
	}
	return false;
}

export function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

export class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// Skip malformed lines
		return null;
	}
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

function sessionKeyMatches(header: SessionHeader, key: SessionLookupKey): boolean {
	if (header.channel !== undefined && header.channelSessionId !== undefined) {
		return (
			sessionLookupKey({ channel: header.channel, channelSessionId: header.channelSessionId }) ===
			sessionLookupKey(key)
		);
	}
	return key.channel === "cli" && key.channelSessionId === resolvePath(header.cwd);
}

/** Newest activity first. A rotated log starts with copies of its parent's last messages, so the two tie on activity
 * until the next message; the newer log wins the tie. */
function byRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime();
}

export function findMostRecentSession(sessionDir: string, cwd?: string, key?: SessionLookupKey): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	let selected: string | undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(key
						? sessionKeyMatches(file.header, key)
						: !resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		selected = files[0]?.path;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
	return selected ? resolveSessionFile(selected) : null;
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(
	filePath: string,
	options: { channel?: string; includeClosedLogs?: boolean } = {},
): Promise<SessionInfo | null> {
	const { channel, includeClosedLogs = false } = options;
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const stream = createReadStream(filePath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				if (channel !== undefined && entry.channel !== channel) {
					// Filtered out by header alone: stop reading the rest of the file (it can be huge).
					rl.close();
					stream.destroy();
					return null;
				}
				header = entry;
				try {
					if (!includeClosedLogs && resolveSessionFile(filePath) !== resolvePath(filePath)) {
						rl.close();
						stream.destroy();
						return null;
					}
				} catch {
					// A broken chain stays discoverable; selecting it reports the resolution error.
				}
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			channel: header.channel,
			channelSessionId: header.channelSessionId,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
	channel?: string,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file, { channel })
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
	channel?: string,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(
			files,
			() => {
				loaded++;
				onProgress?.(progressOffset + loaded, total);
			},
			channel,
		);
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * List all sessions for a directory.
 * @param cwd Working directory (used to compute default session directory)
 * @param sessionDir Optional session directory. If omitted, uses default (~/.theoses/agent/sessions/<encoded-cwd>/).
 * @param onProgress Optional callback for progress updates (loaded, total)
 */
export async function listSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
	key: SessionLookupKey = { channel: "cli", channelSessionId: resolvePath(cwd) },
): Promise<SessionInfo[]> {
	const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
	const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
	const resolvedCwd = resolvePath(cwd);
	const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
		(session) =>
			(session.channel !== undefined && session.channelSessionId !== undefined
				? sessionLookupKey({ channel: session.channel, channelSessionId: session.channelSessionId }) ===
					sessionLookupKey(key)
				: key.channel === "cli" &&
					key.channelSessionId === resolvedCwd &&
					sessionCwdMatches(session.cwd, resolvedCwd)) &&
			(!filterCwd || sessionCwdMatches(session.cwd, resolvedCwd)),
	);
	sessions.sort(byRecency);
	return sessions;
}

/**
 * List all sessions across all project directories.
 * @param onProgress Optional callback for progress updates (loaded, total)
 * @param channel Optional channel filter (e.g. "dashboard"). Sessions whose header channel
 *   doesn't match are dropped without reading past the header, so filtering out large
 *   session files (e.g. Telegram's) is cheap.
 */
export async function listAllSessions(
	sessionDirOrOnProgress?: string | SessionListProgress,
	onProgressOrChannel?: SessionListProgress | string,
	channelArg?: string,
): Promise<SessionInfo[]> {
	const customSessionDir =
		typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
	const progress =
		typeof sessionDirOrOnProgress === "function"
			? sessionDirOrOnProgress
			: typeof onProgressOrChannel === "function"
				? onProgressOrChannel
				: undefined;
	const channel = typeof onProgressOrChannel === "string" ? onProgressOrChannel : channelArg;
	const files = sessionFiles(customSessionDir);
	let loaded = 0;
	const results = await buildSessionInfosWithConcurrency(files, () => progress?.(++loaded, files.length), channel);
	return results.filter((info): info is SessionInfo => info !== null).sort(byRecency);
}
