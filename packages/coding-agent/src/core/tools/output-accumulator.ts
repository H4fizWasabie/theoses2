import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead, truncateTail } from "./truncate.ts";

/**
 * Share of the line and byte budget given to the start of truncated output; the rest goes to the
 * omitted-middle marker and the end. Even, because the start of a listing and the errors and exit
 * summary at the end of a build are both what the reader came for.
 */
const HEAD_SHARE = 0.5;

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/** Directory to spill the full output into when truncated. Defaults to the OS temp dir. */
	spillDir?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string, dir: string): string {
	const id = randomBytes(8).toString("hex");
	return join(dir, `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * head and tail for display snapshots, and opens a temp file when the full
 * output needs to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly headMaxLines: number;
	private readonly headMaxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly spillDir: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private headRaw = "";
	private headFrozen = false;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.headMaxLines = Math.floor(this.maxLines * HEAD_SHARE);
		this.headMaxBytes = Math.floor(this.maxBytes * HEAD_SHARE);
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.spillDir = options.spillDir ?? tmpdir();
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	/**
	 * Under the budget: the output as it is. Over it: the head, a marker naming the omitted lines and
	 * the full-output path, and the tail, all within maxLines and maxBytes.
	 */
	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		if (!truncated) {
			const truncation = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes });
			return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
		}
		if (options.persistIfTruncated) {
			this.ensureTempFile();
		}

		const totalLines = this.totalLines;
		const head = truncateHead(this.headRaw, { maxLines: this.headMaxLines, maxBytes: this.headMaxBytes });
		const headLines = head.outputLines;
		const where = this.tempFilePath ? `; full output: ${this.tempFilePath}` : "";
		const marker = (omitted: number, tailStart: number) =>
			omitted > 0
				? `[... ${omitted} lines omitted (lines ${headLines + 1}-${tailStart - 1})${where} ...]`
				: `[... start of line ${tailStart} omitted${where} ...]`;
		// Widest marker this output can need, plus the two newlines around it.
		const reserve = byteLength(marker(totalLines, totalLines + 1)) + 2;
		const tail = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines - headLines - 1,
			maxBytes: this.maxBytes - head.outputBytes - reserve,
		});
		const tailStart = totalLines - tail.outputLines + 1;
		const middle = marker(tailStart - headLines - 1, tailStart);
		const content = headLines > 0 ? `${head.content}\n${middle}\n${tail.content}` : `${middle}\n${tail.content}`;

		const truncation: TruncationResult = {
			...tail,
			truncated: true,
			truncatedBy: tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"),
			totalLines,
			totalBytes: this.totalDecodedBytes,
			outputLines: headLines + tail.outputLines,
			outputBytes: byteLength(content),
			headLines,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};
		return { content, truncation, fullOutputPath: this.tempFilePath };
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}
		if (!this.headFrozen) {
			this.headRaw += text;
			// Small margin over headMaxBytes so the later byte-safe cut always has enough to work with.
			if (byteLength(this.headRaw) >= this.headMaxBytes * 2) {
				this.headFrozen = true;
			}
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix, this.spillDir);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
