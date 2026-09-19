import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXTERNAL_IMAGE_MIN_CHARS,
	externalizeImages,
	externalizeSessionFile,
	hydrateImages,
	imageFileName,
	saveImageFile,
} from "../src/core/session-images.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/** Canonical base64 of `bytes` filler bytes, so a save-then-load round trip returns the identical string. */
const image = (bytes = 4000, fill = 7) => Buffer.alloc(bytes, fill).toString("base64");

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason: "stop",
		timestamp: 1,
	}) as never;

describe("session images", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `theoses-session-images-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	describe("image files", () => {
		it("names a file by its content and picks the extension from the mime type", () => {
			const data = image();

			expect(imageFileName(data, "image/png")).toMatch(/^[0-9a-f]{32}\.png$/);
			expect(imageFileName(data, "image/png")).toBe(imageFileName(data, "image/png"));
			expect(imageFileName(data, "image/jpeg")).toMatch(/\.jpg$/);
			expect(imageFileName(data, "image/webp")).toMatch(/\.webp$/);
			expect(imageFileName(data, "application/x-weird")).toMatch(/\.bin$/);
			expect(imageFileName(image(4000, 8), "image/png")).not.toBe(imageFileName(data, "image/png"));
		});

		it("saves the decoded bytes once, privately, and returns the same path every time", () => {
			const data = image(3000, 9);

			const path = saveImageFile(root, data, "image/png");
			const again = saveImageFile(root, data, "image/png");

			expect(path).toBe(again);
			expect(path).toContain(join(root, "images"));
			expect(readFileSync(path as string)).toEqual(Buffer.alloc(3000, 9));
			if (process.platform !== "win32") expect(statSync(path as string).mode & 0o777).toBe(0o600);
			expect(readdirSync(join(root, "images"))).toHaveLength(1);
		});

		it("returns undefined instead of throwing when it cannot write", () => {
			const blocker = join(root, "not-a-directory");
			writeFileSync(blocker, "x");

			expect(saveImageFile(blocker, image(), "image/png")).toBeUndefined();
		});
	});

	describe("externalizeImages and hydrateImages", () => {
		it("replaces a large image with a reference and leaves the input untouched", () => {
			const data = image();
			const entry = {
				type: "message",
				id: "1",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data, mimeType: "image/png" },
					],
				},
			};
			const before = JSON.stringify(entry);

			const written = externalizeImages(entry, () => root) as typeof entry;

			expect(JSON.stringify(entry)).toBe(before);
			const block = written.message.content[1] as unknown as Record<string, unknown>;
			expect(block).toEqual({
				type: "image",
				mimeType: "image/png",
				data: "",
				ref: `images/${imageFileName(data, "image/png")}`,
			});
			expect(written.message.content[0]).toEqual({ type: "text", text: "look" });
			expect(JSON.stringify(written)).not.toContain(data);
		});

		it("keeps small images inline and returns the same object when there is nothing to move", () => {
			const small = Buffer.alloc(500, 1).toString("base64");
			expect(small.length).toBeLessThan(EXTERNAL_IMAGE_MIN_CHARS);
			const entry = {
				type: "message",
				id: "1",
				message: { role: "user", content: [{ type: "image", data: small, mimeType: "image/png" }] },
			};
			const plain = { type: "message", id: "2", message: { role: "user", content: "just text" } };
			let asked = 0;
			const directory = () => {
				asked++;
				return root;
			};

			expect(externalizeImages(entry, directory)).toBe(entry);
			expect(externalizeImages(plain, directory)).toBe(plain);
			expect(asked).toBe(0);
		});

		it("handles tool results and custom messages", () => {
			const a = image(3000, 1);
			const b = image(3000, 2);
			const toolResult = {
				type: "message",
				id: "1",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "image", data: a, mimeType: "image/jpeg" }],
				},
			};
			const custom = {
				type: "custom_message",
				id: "2",
				content: [{ type: "image", data: b, mimeType: "image/webp" }],
			};

			const written = [externalizeImages(toolResult, () => root), externalizeImages(custom, () => root)];

			expect(JSON.stringify(written)).not.toContain(a);
			expect(JSON.stringify(written)).not.toContain(b);
			expect(readdirSync(join(root, "images")).sort()).toEqual(
				[imageFileName(a, "image/jpeg"), imageFileName(b, "image/webp")].sort(),
			);
		});

		it("keeps the image inline when it cannot be saved", () => {
			const blocker = join(root, "file");
			writeFileSync(blocker, "x");
			const data = image();
			const entry = {
				type: "message",
				id: "1",
				message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] },
			};

			const written = externalizeImages(entry, () => blocker) as typeof entry;

			expect(written.message.content[0]).toMatchObject({ type: "image", data });
		});

		it("restores the bytes on load, exactly as they were", () => {
			const data = image(5000, 3);
			const entry = {
				type: "message",
				id: "1",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "hi" },
						{ type: "image", data, mimeType: "image/png" },
					],
				},
			};
			const persisted = JSON.parse(JSON.stringify(externalizeImages(entry, () => root)));

			expect(hydrateImages([persisted], root)).toBe(0);

			expect(persisted).toEqual(entry);
		});

		it("turns an image whose file is gone into a text note instead of failing", () => {
			const data = image();
			const entry = {
				type: "message",
				id: "1",
				message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] },
			};
			const persisted = JSON.parse(JSON.stringify(externalizeImages(entry, () => root)));
			rmSync(join(root, "images"), { recursive: true });

			expect(hydrateImages([persisted], root)).toBe(1);

			expect(persisted.message.content[0]).toMatchObject({ type: "text" });
			expect(persisted.message.content[0].text).toContain("image unavailable");
		});

		it("leaves entries and blocks that are not references alone", () => {
			const inline = { type: "image", data: image(), mimeType: "image/png" };
			const entries = [
				{ type: "session", id: "s" },
				{ type: "message", id: "1", message: { role: "user", content: [inline, { type: "text", text: "x" }] } },
			];
			const before = JSON.stringify(entries);

			expect(hydrateImages(entries, root)).toBe(0);

			expect(JSON.stringify(entries)).toBe(before);
		});
	});

	describe("in a session log", () => {
		function makeSession() {
			const sessionDir = join(root, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			return { sessionDir, manager: SessionManager.create(root, sessionDir) };
		}

		it("writes references instead of image data, and a reopened session has the bytes back", () => {
			const { manager } = makeSession();
			const photo = image(6000, 5);
			const shot = image(7000, 6);
			manager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{ type: "image", data: photo, mimeType: "image/jpeg" },
				],
				timestamp: 1,
			} as never);
			manager.appendMessage(assistant("looking"));
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "image", data: shot, mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			} as never);

			const file = manager.getSessionFile() as string;
			const raw = readFileSync(file, "utf8");
			expect(raw).not.toContain(photo);
			expect(raw).not.toContain(shot);
			expect(raw).toContain(`"ref":"images/${imageFileName(photo, "image/jpeg")}"`);
			expect(raw).toContain(`"ref":"images/${imageFileName(shot, "image/png")}"`);
			expect(existsSync(join(manager.getArtifactDirectory(), "images", imageFileName(photo, "image/jpeg")))).toBe(
				true,
			);

			const reopened = SessionManager.open(file);
			const blocks = reopened.getEntries().flatMap((entry) => {
				if (entry.type !== "message") return [];
				const content = (entry.message as { content?: unknown }).content;
				return Array.isArray(content) ? (content as Array<{ type: string; data?: string }>) : [];
			});
			expect(blocks.filter((block) => block.type === "image").map((block) => block.data)).toEqual([photo, shot]);
		});

		it("keeps the in-memory entries unchanged while writing", () => {
			const { manager } = makeSession();
			const data = image();
			manager.appendMessage({
				role: "user",
				content: [{ type: "image", data, mimeType: "image/png" }],
				timestamp: 1,
			} as never);
			manager.appendMessage(assistant("ok"));

			const entry = manager.getEntries().find((e) => e.type === "message" && e.message.role === "user");

			expect(JSON.stringify(entry)).toContain(data);
		});

		it("survives a copy of the log into a new session (fork), saving the images beside the new log", () => {
			const { manager } = makeSession();
			const data = image(6000, 4);
			manager.appendMessage({
				role: "user",
				content: [{ type: "image", data, mimeType: "image/png" }],
				timestamp: 1,
			} as never);
			const leafId = manager.appendMessage(assistant("ok"));

			const branchFile = manager.createBranchedSession(leafId);
			expect(branchFile).toBeDefined();

			const raw = readFileSync(branchFile as string, "utf8");
			expect(raw).not.toContain(data);
			expect(JSON.stringify(SessionManager.open(branchFile as string).getEntries())).toContain(data);
		});

		it("does not touch the disk for a session that is not persisted", () => {
			const cwd = join(root, "cwd");
			mkdirSync(cwd);
			const manager = SessionManager.inMemory(cwd);
			manager.appendMessage({
				role: "user",
				content: [{ type: "image", data: image(), mimeType: "image/png" }],
				timestamp: 1,
			} as never);
			manager.appendMessage(assistant("ok"));

			expect(readdirSync(cwd)).toEqual([]);
			expect(JSON.stringify(manager.getEntries())).toContain(image());
		});

		it("still loads a session whose saved image file was deleted", () => {
			const { manager } = makeSession();
			manager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "see" },
					{ type: "image", data: image(), mimeType: "image/png" },
				],
				timestamp: 1,
			} as never);
			manager.appendMessage(assistant("ok"));
			rmSync(join(manager.getArtifactDirectory(), "images"), { recursive: true });

			const reopened = SessionManager.open(manager.getSessionFile() as string);

			expect(JSON.stringify(reopened.getEntries())).toContain("image unavailable");
		});
	});

	describe("externalizeSessionFile", () => {
		/** Builds a log in the old format: a normal session whose image references are turned back into inline data. */
		function legacyLog() {
			const sessionDir = join(root, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const manager = SessionManager.create(root, sessionDir);
			const data = image(8000, 2);
			manager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "old" },
					{ type: "image", data, mimeType: "image/png" },
				],
				timestamp: 1,
			} as never);
			manager.appendMessage(assistant("ok"));
			const file = manager.getSessionFile() as string;
			const lines = readFileSync(file, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			hydrateImages(lines, manager.getArtifactDirectory());
			rmSync(join(manager.getArtifactDirectory(), "images"), { recursive: true });
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json at all\n`);
			const old = new Date(Date.now() - 10 * 60_000);
			utimesSync(file, old, old);
			return { file, data, artifactDir: manager.getArtifactDirectory() };
		}

		it("counts what would move on a dry run and changes nothing", () => {
			const { file, data } = legacyLog();
			const before = readFileSync(file, "utf8");

			const result = externalizeSessionFile(file, { dryRun: true });

			expect(result.images).toBe(1);
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(before).toContain(data);
			expect(existsSync(`${file}.pre-image-externalize.bak`)).toBe(false);
		});

		it("moves inline images out, keeps a backup, and the session still loads with the same images", () => {
			const { file, data } = legacyLog();
			const original = readFileSync(file, "utf8");

			const result = externalizeSessionFile(file);

			expect(result.images).toBe(1);
			expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
			const rewritten = readFileSync(file, "utf8");
			expect(rewritten).not.toContain(data);
			expect(rewritten).toContain("not json at all");
			expect(readFileSync(result.backupPath as string, "utf8")).toBe(original);
			expect(JSON.stringify(SessionManager.open(file).getEntries())).toContain(data);
		});

		it("does nothing a second time", () => {
			const { file } = legacyLog();
			externalizeSessionFile(file);
			const after = readFileSync(file, "utf8");

			// The first run just modified the file, so a second run needs force to get past the recent-write guard.
			expect(externalizeSessionFile(file, { force: true }).images).toBe(0);
			expect(readFileSync(file, "utf8")).toBe(after);
		});

		it("refuses a file modified in the last 30 seconds unless forced", () => {
			const { file } = legacyLog();
			const now = new Date();
			utimesSync(file, now, now);

			expect(() => externalizeSessionFile(file)).toThrow(/modified in the last 30 seconds/);
			expect(externalizeSessionFile(file, { force: true }).images).toBe(1);
		});

		it("rejects a file that is not a session log", () => {
			const file = join(root, "other.jsonl");
			writeFileSync(file, '{"hello":"world"}\n');
			const old = new Date(Date.now() - 10 * 60_000);
			utimesSync(file, old, old);

			expect(() => externalizeSessionFile(file)).toThrow(/session header/);
		});
	});
});
