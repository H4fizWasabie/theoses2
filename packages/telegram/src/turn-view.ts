import { type AgentSessionEvent, describeFinalError, type PromptResult } from "theoses-coding-agent";
import { chunkHtml, formatTelegramHtml, renderToolCallBlocks, splitSections, type ToolCallEntry } from "./format.ts";
import { createToolCallLogger } from "./tool-call-log.ts";

const TELEGRAM_MESSAGE_LIMIT = 4000;
// Bot API's own documented ceiling for a rich message's text (headings/bold/tables/etc combined).
const RICH_MESSAGE_CHAR_LIMIT = 32768;

export type MessageFormat = "rich" | "html" | "plain";

/**
 * Plain transport to one chat. Every method throws when Telegram rejects the call; deciding what to
 * try next is the Turn View's job. Two adapters: grammy in production, a recording fake in tests.
 */
export interface Outbox {
	/** Returns the sent message's id. */
	send(text: string, format: MessageFormat, replyTo?: number): Promise<number>;
	edit(messageId: number, text: string, format: MessageFormat): Promise<void>;
	delete(messageId: number): Promise<void>;
	sendPhotos(images: Buffer[]): Promise<void>;
}

export interface TurnViewOptions {
	/** The owner message this turn answers; the status message and the reply thread to it. */
	replyTo: number;
	/** Each tool call as its own status entry instead of "Running <tool>..." and a tool-name footer. */
	toolCallDetail: boolean;
}

/**
 * How one turn looks in the chat: a live status message while tools run, which then becomes the answer
 * (or, in tool-call-detail mode, stays as the tool block with the answer sent separately); the provider
 * error when the turn failed; generated images; and nothing at all when /stop halted it.
 */
export function createTurnView(outbox: Outbox, options: TurnViewOptions) {
	const { replyTo, toolCallDetail } = options;
	let response: string | undefined;
	let statusMessageId: number | undefined;
	let statusPending: Promise<unknown> = Promise.resolve();
	const toolNames: string[] = [];
	const toolCallEntries: ToolCallEntry[] = [];
	const generatedImages: Buffer[] = [];
	const toolCallLogger = createToolCallLogger();

	/** Sends the status message once, then edits it in place. Failures (rate limits, "not modified") are ignored. */
	const setStatus = (text: string, format: MessageFormat) => {
		statusPending = statusPending.then(async () => {
			try {
				if (statusMessageId === undefined) statusMessageId = await outbox.send(text, format, replyTo);
				else await outbox.edit(statusMessageId, text, format);
			} catch {
				// Ignore transient status failures.
			}
		});
	};

	return {
		onEvent(event: AgentSessionEvent): void {
			response = assistantText(event) ?? response;
			if (event.type === "tool_execution_start") {
				toolCallLogger.start(event.toolCallId);
				if (toolCallDetail) {
					toolCallEntries.push({ id: event.toolCallId, name: event.toolName, args: event.args });
					setStatus(renderToolCallBlocks(toolCallEntries), "rich");
				} else {
					setStatus(`Running ${event.toolName}...`, "plain");
				}
			}
			if (event.type === "tool_execution_end") {
				toolCallLogger.end(event);
				toolNames.push(event.toolName);
				generatedImages.push(...extractGeneratedImages(event.toolName, event.result));
				if (toolCallDetail) {
					const entry = toolCallEntries.find((e) => e.id === event.toolCallId);
					if (entry) {
						entry.done = true;
						entry.isError = event.isError;
					}
					setStatus(renderToolCallBlocks(toolCallEntries), "rich");
				}
			}
		},

		/** `resumeInMs` is set when the adapter will resume a failed turn automatically; the error says so. */
		async finish(result: PromptResult | undefined, { resumeInMs }: { resumeInMs?: number } = {}): Promise<void> {
			await statusPending;
			// /stop already replied; the halted turn's partial output is dropped.
			if (result?.outcome === "aborted") {
				if (statusMessageId !== undefined) await outbox.delete(statusMessageId).catch(() => {});
				return;
			}
			// Tool-call-detail mode: the status message is the finished tool-call block and stays its own chat
			// entry, so the answer always lands as a separate message instead of replacing that block.
			const editTarget = toolCallDetail ? undefined : statusMessageId;
			// Issue #211: a failed turn has no text for assistantText() to find, so without this the bot went
			// silent on provider failures. finalError is the last attempt's, after all retries.
			const failure = describeFinalError(result);
			const errorText =
				failure &&
				failure +
					(resumeInMs === undefined
						? ""
						: `\nResuming automatically in ${resumeInMs / 1000}s. Send any message to cancel.`);
			if (response) {
				// Narration from before the failure must not hide it (2026-09-24: the owner saw only "Now
				// proving it works..." and assumed the model stopped without calling a tool).
				const reply = errorText ? `${response}\n\n${errorText}` : response;
				await sendReply(outbox, reply, toolCallDetail ? [] : toolNames, replyTo, editTarget);
			} else if (errorText) {
				if (editTarget !== undefined) await outbox.edit(editTarget, errorText, "plain").catch(() => {});
				else await outbox.send(errorText, "plain", replyTo).catch(() => {});
			} else if (editTarget !== undefined) {
				await outbox.delete(editTarget).catch(() => {});
			}
			if (generatedImages.length > 0) await outbox.sendPhotos(generatedImages);
		},
	};
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

/**
 * Pulls generate_image output out of a raw tool result for delivery as Telegram photos. Other tools are
 * skipped: `read` on an image file also returns an image block, and delivering that one too duplicated
 * the photo whenever the agent sent the file itself.
 */
export function extractGeneratedImages(toolName: string, result: unknown): Buffer[] {
	if (toolName !== "generate_image") return [];
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: "image"; data: string } => (part as { type?: string })?.type === "image")
		.map((part) => Buffer.from(part.data, "base64"));
}

/**
 * Single exit point for outbound reply text: section-split on --- lines -> format -> chunk -> send.
 * Each section threads to the previous one (the owner's message for the first) so multi-part replies
 * read as one chain. If `statusMessageId` is given, the very first chunk edits it in place, so the
 * status message becomes the answer rather than being replaced by a separate one. Ported from Mino's
 * sendTelegramReply.
 */
async function sendReply(
	outbox: Outbox,
	reply: string,
	toolNames: string[],
	replyTo: number,
	statusMessageId: number | undefined,
): Promise<void> {
	const sections = splitSections(reply);
	let lastId: number | undefined = replyTo;
	let pendingEditId = statusMessageId;
	for (const [index, section] of sections.entries()) {
		// Rich messages (Bot API 10.1) render tables, headings, collapsible blocks, footnotes and quotes
		// natively. Attempted unconditionally for every section under the rich limit (issue #194: rich
		// markdown is a strict superset of what classic HTML handles, so a content-based gate only adds
		// maintenance). There is no documented behavior for clients that predate 10.1, so any failure -
		// old client, malformed markdown, network error - is logged and falls through to the classic HTML
		// path for this section. Sections over the rich limit go straight to classic chunking: splitting
		// rich markdown risks cutting mid-table/list/code block, classic chunking splits at safe boundaries.
		if (section.length <= RICH_MESSAGE_CHAR_LIMIT) {
			const editId = pendingEditId;
			try {
				if (editId !== undefined) {
					await outbox.edit(editId, section, "rich");
					lastId = editId;
					pendingEditId = undefined;
				} else {
					lastId = await outbox.send(section, "rich", lastId);
				}
				continue;
			} catch (error) {
				console.warn(
					`[rich-message] ${editId !== undefined ? "edit" : "send"} failed, falling back to classic HTML:`,
					error instanceof Error ? error.message : error,
				);
				// pendingEditId is left untouched so the classic path still edits the status message first.
			}
		}

		const names = index === sections.length - 1 ? toolNames : [];
		// A chunk Telegram rejects as HTML (malformed markup -> 400) is resent as plain text: stray tags
		// beat a lost message.
		for (const chunk of chunkHtml(formatTelegramHtml(section, names), TELEGRAM_MESSAGE_LIMIT)) {
			const editId = pendingEditId;
			pendingEditId = undefined; // only the very first chunk overall replaces the status message
			if (editId !== undefined) {
				try {
					await outbox.edit(editId, chunk, "html");
					lastId = editId;
					continue;
				} catch {
					try {
						await outbox.edit(editId, chunk, "plain");
						lastId = editId;
						continue;
					} catch {
						// Status message may have been deleted or rate-limited; fall through to sending fresh.
					}
				}
			}
			try {
				lastId = await outbox.send(chunk, "html", lastId);
			} catch {
				const sent: number | undefined = await outbox.send(chunk, "plain", lastId).catch(() => undefined);
				if (sent !== undefined) lastId = sent;
			}
		}
	}
}
