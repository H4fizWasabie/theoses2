interface PayloadFingerprint {
	messageHashes: string[];
	messageTexts: string[];
	restHash: string;
	toolsHash: string;
}

const DIFF_CONTEXT_CHARS = 80;
const previousBySession = new Map<string, PayloadFingerprint>();

// FNV-1a: this package must stay browser-safe, so no node:crypto. Collisions only matter for a debug log.
function hash(value: unknown): string {
	const text = JSON.stringify(value) ?? "";
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

function fingerprint(payload: Record<string, unknown>): PayloadFingerprint {
	const { messages, tools, ...rest } = payload;
	const list = Array.isArray(messages) ? messages : [];
	return {
		messageHashes: list.map(hash),
		messageTexts: list.map((message) => JSON.stringify(message) ?? ""),
		restHash: hash(rest),
		toolsHash: hash(tools),
	};
}

/**
 * Opt-in (THEOSES_DEBUG_CACHE_PREFIX=1) diagnostic for prompt-cache misses. Providers cache by exact
 * prefix, so a call that misses although the previous call in the same session had a byte-identical
 * history means something rewrote an earlier message or tool definition. Logs, per request, the first
 * message index that differs from the previous request of the same session (append-only growth is
 * reported as "prefix intact"), so a real conversation shows exactly which step breaks the prefix.
 */
export function logCachePrefixDiff(sessionId: string | undefined, payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const key = sessionId ?? "no-session";
	const current = fingerprint(payload as Record<string, unknown>);
	const previous = previousBySession.get(key);
	previousBySession.set(key, current);
	const tag = `[cache-prefix] session=${key.slice(0, 8)} msgs=${current.messageHashes.length}`;
	if (!previous) {
		console.error(`${tag} first request for session`);
		return;
	}
	const flags = [
		current.toolsHash === previous.toolsHash ? "" : " TOOLS_CHANGED",
		current.restHash === previous.restHash ? "" : " PARAMS_CHANGED",
	].join("");
	const shared = Math.min(previous.messageHashes.length, current.messageHashes.length);
	let firstDiff = -1;
	for (let i = 0; i < shared; i++) {
		if (previous.messageHashes[i] !== current.messageHashes[i]) {
			firstDiff = i;
			break;
		}
	}
	if (firstDiff === -1) {
		console.error(`${tag} prevMsgs=${previous.messageHashes.length} prefix intact${flags}`);
		return;
	}
	const was = previous.messageTexts[firstDiff];
	const now = current.messageTexts[firstDiff];
	let charIndex = 0;
	while (charIndex < was.length && charIndex < now.length && was[charIndex] === now[charIndex]) charIndex++;
	const from = Math.max(0, charIndex - DIFF_CONTEXT_CHARS);
	const window = (text: string) => text.slice(from, charIndex + DIFF_CONTEXT_CHARS);
	console.error(
		`${tag} prevMsgs=${previous.messageHashes.length} PREFIX_BROKEN at=${firstDiff} char=${charIndex}/${now.length}${flags}\n` +
			`  was: ...${window(was)}\n  now: ...${window(now)}`,
	);
}
