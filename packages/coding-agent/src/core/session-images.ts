/**
 * Keeps image bytes out of the session log.
 *
 * Images arrive as base64 inside messages (a photo you send, a screenshot the `read` tool opens), and
 * every one used to be written into the session JSONL line by line: about 42 MB of the 73 MB prod
 * session file was image data, all of it re-read and re-parsed on every restart.
 *
 * Each image is now saved once as a real image file in the session's artifact directory,
 * `images/<sha256>.<ext>` (content-addressed, so the same screenshot read ten times is one file), and
 * the log line carries a reference instead: `{ type: "image", mimeType, data: "", ref: "images/..." }`.
 * Loading a session puts the bytes back, so everything in memory keeps its usual shape. The same files
 * are what context pruning points a model at when it drops an old image from the live context.
 *
 * Every step fails open: if a file cannot be written the image stays inline in the log, and if a file
 * is missing when a session is loaded the image becomes a short text note instead of breaking the load.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Base64 shorter than this stays inline: not worth a file, and it keeps tiny test images readable. */
export const EXTERNAL_IMAGE_MIN_CHARS = 2048;

const IMAGES_DIRECTORY = "images";

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

/** The persisted form of an image block. `data` is empty; the bytes live in the file `ref` names. */
export interface ExternalImageBlock {
	type: "image";
	mimeType: string;
	data: "";
	/** Path of the image file relative to the session's artifact directory. */
	ref: string;
}

function extensionFor(mimeType: string): string {
	return EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}

/** Content-addressed file name: the same bytes always map to the same file. */
export function imageFileName(data: string, mimeType: string): string {
	return `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${extensionFor(mimeType)}`;
}

/**
 * Saves an image under `<artifactDir>/images/` if it is not already there and returns its absolute
 * path, or undefined if it could not be written. Safe to call repeatedly for the same image.
 */
export function saveImageFile(artifactDir: string, data: string, mimeType: string): string | undefined {
	try {
		const directory = join(artifactDir, IMAGES_DIRECTORY);
		const path = join(directory, imageFileName(data, mimeType));
		if (existsSync(path)) return path;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

function isInlineImage(block: unknown): block is { type: "image"; data: string; mimeType: string } {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
	return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
}

function isExternalImage(block: unknown): block is ExternalImageBlock {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as { type?: unknown; ref?: unknown; mimeType?: unknown };
	return candidate.type === "image" && typeof candidate.ref === "string" && typeof candidate.mimeType === "string";
}

/** The content arrays an entry can carry images in: a message's content, or a custom message's. */
function contentArraysOf(entry: unknown): unknown[][] {
	if (typeof entry !== "object" || entry === null) return [];
	const record = entry as { message?: { content?: unknown }; content?: unknown };
	const arrays: unknown[][] = [];
	if (Array.isArray(record.message?.content)) arrays.push(record.message.content);
	if (Array.isArray(record.content)) arrays.push(record.content);
	return arrays;
}

/**
 * Returns the entry as it should be written to the session log: image blocks large enough to matter
 * are saved to files and replaced by references. The input is never modified (the in-memory entry
 * keeps its bytes); an entry without such images is returned as it is. `artifactDir` is a function so
 * the directory is only created when there is an image to save.
 */
export function externalizeImages<T>(entry: T, artifactDir: () => string): T {
	const arrays = contentArraysOf(entry);
	if (
		!arrays.some((content) =>
			content.some((block) => isInlineImage(block) && block.data.length >= EXTERNAL_IMAGE_MIN_CHARS),
		)
	) {
		return entry;
	}
	let directory: string | undefined;
	const externalize = (content: unknown[]): unknown[] =>
		content.map((block) => {
			if (!isInlineImage(block) || block.data.length < EXTERNAL_IMAGE_MIN_CHARS) return block;
			directory ??= artifactDir();
			const path = saveImageFile(directory, block.data, block.mimeType);
			if (!path) return block; // could not save: keep the image inline rather than lose it
			const reference: ExternalImageBlock = {
				type: "image",
				mimeType: block.mimeType,
				data: "",
				ref: `${IMAGES_DIRECTORY}/${imageFileName(block.data, block.mimeType)}`,
			};
			return reference;
		});

	const copy = { ...(entry as object) } as { message?: { content?: unknown }; content?: unknown };
	const message = copy.message;
	if (message && Array.isArray(message.content)) copy.message = { ...message, content: externalize(message.content) };
	if (Array.isArray(copy.content)) copy.content = externalize(copy.content);
	return copy as T;
}

/**
 * Puts image bytes back into entries loaded from a session log, in place. A block whose file is
 * missing or unreadable becomes a text note, so one lost image never makes the session unloadable.
 * Returns how many images could not be restored.
 */
export function hydrateImages(entries: unknown[], artifactDir: string): number {
	let missing = 0;
	const hydrate = (content: unknown[]): void => {
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (!isExternalImage(block)) continue;
			try {
				content[index] = {
					type: "image",
					data: readFileSync(join(artifactDir, block.ref)).toString("base64"),
					mimeType: block.mimeType,
				};
			} catch {
				missing++;
				content[index] = { type: "text", text: `[image unavailable: the saved file ${block.ref} is missing]` };
			}
		}
	};
	for (const entry of entries) for (const content of contentArraysOf(entry)) hydrate(content);
	return missing;
}

export interface ExternalizeSessionFileOptions {
	/** Count what would change without writing any file. */
	dryRun?: boolean;
	/** Rewrite a file even if it was modified moments ago (a running service may still be appending to it). */
	force?: boolean;
	/** Clock, for tests. */
	now?: () => number;
}

export interface ExternalizeSessionFileResult {
	/** Inline images at least EXTERNAL_IMAGE_MIN_CHARS long that were (or would be) moved out of the log. */
	images: number;
	bytesBefore: number;
	bytesAfter: number;
	backupPath?: string;
}

/** A file modified this recently may still be receiving lines from a running service. */
const RECENTLY_MODIFIED_MS = 30_000;

/**
 * One-off migration for a session log written before images were kept out of it: rewrites the file
 * so every large inline image becomes a saved file plus a reference. Not safe against a concurrent
 * writer: lines appended between the read and the replace would be lost, so it refuses a file
 * modified in the last 30 seconds unless forced, and the service that owns the file should be stopped.
 * The original is kept next to it as `<file>.pre-image-externalize.bak`; the replace is atomic.
 */
export function externalizeSessionFile(
	sessionFile: string,
	options: ExternalizeSessionFileOptions = {},
): ExternalizeSessionFileResult {
	const stat = statSync(sessionFile);
	const now = options.now ?? Date.now;
	if (!options.force && now() - stat.mtimeMs < RECENTLY_MODIFIED_MS) {
		throw new Error(
			`${sessionFile} was modified in the last ${RECENTLY_MODIFIED_MS / 1000} seconds; stop the service that writes it, or pass --force`,
		);
	}
	const lines = readFileSync(sessionFile, "utf8").split("\n");
	let sessionId: string | undefined;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const header = JSON.parse(line) as { type?: string; id?: unknown };
			if (header.type === "session" && typeof header.id === "string") sessionId = header.id;
		} catch {
			// keep looking for a parseable header
		}
		break;
	}
	if (!sessionId) throw new Error(`${sessionFile} does not start with a session header`);
	const artifactDir = join(dirname(sessionFile), "artifacts", sessionId);

	let images = 0;
	const rewritten = lines.map((line) => {
		if (!line.includes('"type":"image"')) return line;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return line;
		}
		const inline = contentArraysOf(entry).flatMap((content) =>
			content.filter((block) => isInlineImage(block) && block.data.length >= EXTERNAL_IMAGE_MIN_CHARS),
		);
		if (inline.length === 0) return line;
		if (options.dryRun) {
			images += inline.length;
			return line;
		}
		const converted = externalizeImages(entry, () => artifactDir);
		const after = contentArraysOf(converted).flatMap((content) => content.filter(isExternalImage)).length;
		images += after;
		return JSON.stringify(converted);
	});

	const result: ExternalizeSessionFileResult = { images, bytesBefore: stat.size, bytesAfter: stat.size };
	if (options.dryRun || images === 0) return result;

	const backupPath = `${sessionFile}.pre-image-externalize.bak`;
	copyFileSync(sessionFile, backupPath);
	const temp = `${sessionFile}.tmp-${process.pid}`;
	writeFileSync(temp, rewritten.join("\n"), { mode: stat.mode & 0o777 });
	renameSync(temp, sessionFile);
	return { ...result, bytesAfter: statSync(sessionFile).size, backupPath };
}
