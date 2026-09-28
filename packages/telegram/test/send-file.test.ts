import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSendFileTool, type FileSender } from "../src/send-file.ts";

function recordingSender() {
	const sent: string[] = [];
	const sender: FileSender = {
		async sendPhoto(data, fileName, caption) {
			sent.push(`photo ${fileName} ${data.length}B ${caption ?? "-"}`);
			return 1;
		},
		async sendDocument(data, fileName, caption) {
			sent.push(`document ${fileName} ${data.length}B ${caption ?? "-"}`);
			return 2;
		},
	};
	return { sender, sent };
}

describe("send_file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "telegram-send-file-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = (sender: FileSender, args: { path: string; caption?: string }) =>
		createSendFileTool(dir, sender).execute("call-1", args, undefined, undefined, undefined as never);

	it("sends an image as a photo, resolving the path against cwd", async () => {
		writeFileSync(join(dir, "quote.JPG"), "jpegbytes");
		const { sender, sent } = recordingSender();
		const result = await run(sender, { path: "quote.JPG", caption: "today" });
		expect(sent).toEqual(["photo quote.JPG 9B today"]);
		expect(result.content).toEqual([{ type: "text", text: "Sent quote.JPG to the user as a photo." }]);
	});

	it("sends a non-image as a document", async () => {
		writeFileSync(join(dir, "report.pdf"), "pdf");
		const { sender, sent } = recordingSender();
		await run(sender, { path: join(dir, "report.pdf") });
		expect(sent).toEqual(["document report.pdf 3B -"]);
	});

	it("falls back to a document for an image over the 10 MB photo limit", async () => {
		const big = join(dir, "big.png");
		writeFileSync(big, "");
		truncateSync(big, 11 * 1024 * 1024);
		const { sender, sent } = recordingSender();
		await run(sender, { path: big });
		expect(sent).toEqual([`document big.png ${11 * 1024 * 1024}B -`]);
	});

	it("rejects files over 50 MB and directories without sending", async () => {
		const huge = join(dir, "huge.bin");
		writeFileSync(huge, "");
		truncateSync(huge, 51 * 1024 * 1024);
		mkdirSync(join(dir, "folder"));
		const { sender, sent } = recordingSender();
		await expect(run(sender, { path: huge })).rejects.toThrow("at most 50 MB");
		await expect(run(sender, { path: "folder" })).rejects.toThrow("Not a file");
		await expect(run(sender, { path: "missing.jpg" })).rejects.toThrow();
		expect(sent).toEqual([]);
	});
});
