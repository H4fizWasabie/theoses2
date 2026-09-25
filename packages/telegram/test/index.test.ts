import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";

// The bot's whole view of the agent is one Channel Session per chat; each test installs its fake here.
const registry = vi.hoisted(() => ({ session: undefined as unknown, gate: undefined as Promise<void> | undefined }));

vi.mock("theoses-coding-agent", () => ({
	configureHttpDispatcher: vi.fn(),
	getAgentDir: vi.fn(() => "/tmp/telegram-test-agent-dir"),
	createChannelSessions: vi.fn(() => {
		let opened = false;
		return {
			open: async () => {
				await registry.gate;
				opened = true;
				return registry.session;
			},
			list: () => (opened ? [registry.session] : []),
		};
	}),
}));

import type { AgentSessionEvent, ChannelInput, PromptResult } from "theoses-coding-agent";
import { createTelegramBot, parseModelCommand, replyText } from "../src/index.ts";

/** A fake Channel Session whose turns run `turn`; `isRunning` is true while one does. */
function fakeChannelSession(
	turn: (input: ChannelInput, onEvent?: (event: AgentSessionEvent) => void) => Promise<PromptResult | undefined>,
	stop: () => Promise<void> = async () => {},
) {
	let running = false;
	const session = {
		channelSessionId: "1",
		model: undefined,
		get isRunning() {
			return running;
		},
		submit: vi.fn(async (input: ChannelInput, onEvent?: (event: AgentSessionEvent) => void) => {
			running = true;
			try {
				return await turn(input, onEvent);
			} finally {
				running = false;
			}
		}),
		stop: vi.fn(async () => {
			const wasRunning = running;
			await stop();
			return { wasRunning };
		}),
		switchModel: vi.fn(),
		storeArtifact: vi.fn(),
	};
	registry.session = session;
	registry.gate = undefined;
	return session;
}

function messageUpdate(updateId: number, messageId: number, text: string): Update {
	return {
		update_id: updateId,
		message: {
			message_id: messageId,
			date: 1,
			chat: { id: 1, type: "private" },
			from: { id: 1, is_bot: false, first_name: "Owner" },
			text,
		},
	} as Update;
}

describe("Telegram stop queueing", () => {
	it("identifies and reports a queued message skipped by an active stop", async () => {
		let releasePrompt: (() => void) | undefined;
		const session = fakeChannelSession(
			() =>
				new Promise((resolve) => {
					releasePrompt = () => resolve({ outcome: "aborted" });
				}),
			async () => releasePrompt?.(),
		);

		const bot = createTelegramBot({ token: "test-token", ownerChatId: "1", cwd: "/tmp/telegram-test" });
		bot.botInfo = {
			id: 99,
			is_bot: true,
			first_name: "Test",
			username: "test_bot",
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		};
		const sendMessage = vi.spyOn(bot.api, "sendMessage").mockResolvedValue({ message_id: 100 } as never);

		const active = bot.handleUpdate(messageUpdate(1, 1, "start"));
		await vi.waitFor(() => expect(session.isRunning).toBe(true));
		const queued = bot.handleUpdate(messageUpdate(2, 2, "queued message"));
		const stopped = bot.handleUpdate(messageUpdate(3, 3, "/stop"));

		await stopped;
		await Promise.all([active, queued]);

		expect(session.submit).toHaveBeenCalledTimes(1);
		expect(session.stop).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(1, expect.stringContaining("Also skipped your next queued message."));
	});
});

describe("Telegram update dispatch", () => {
	it("returns from the update handler without waiting for a long-running turn to finish (issue #209)", async () => {
		let releasePrompt: (() => void) | undefined;
		let promptResolved = false;
		const session = fakeChannelSession(async () => {
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			promptResolved = true;
			return { outcome: "completed" };
		});

		const bot = createTelegramBot({ token: "test-token", ownerChatId: "1", cwd: "/tmp/telegram-test" });
		bot.botInfo = {
			id: 99,
			is_bot: true,
			first_name: "Test",
			username: "test_bot",
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		};
		vi.spyOn(bot.api, "sendMessage").mockResolvedValue({ message_id: 100 } as never);

		await bot.handleUpdate(messageUpdate(1, 1, "a long-running message"));

		// The handler must resolve before the turn itself finishes - grammY's default bot.start()
		// dispatches updates strictly sequentially, so a handler that blocks on the full turn
		// (which can run for minutes on a long tool call) makes every subsequent update, including
		// a "/stop", undeliverable until the turn ends on its own.
		await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(1));
		expect(promptResolved).toBe(false);

		releasePrompt?.();
		await vi.waitFor(() => expect(promptResolved).toBe(true));
	});
});

function typingHarness(options: { sessionGate?: Promise<void> } = {}) {
	const listeners: Array<(event: unknown) => void> = [];
	const prompts: Array<(result?: PromptResult) => void> = [];
	const session = fakeChannelSession(
		(_input, onEvent) =>
			new Promise<PromptResult | undefined>((resolve) => {
				if (onEvent) listeners.push(onEvent as (event: unknown) => void);
				prompts.push(resolve);
			}),
	);
	registry.gate = options.sessionGate;

	const bot = createTelegramBot({ token: "test-token", ownerChatId: "1", cwd: "/tmp/telegram-test" });
	bot.botInfo = {
		id: 99,
		is_bot: true,
		first_name: "Test",
		username: "test_bot",
		can_join_groups: false,
		can_read_all_group_messages: false,
		supports_inline_queries: false,
		can_connect_to_business: false,
		can_connect_to_business_apps: false,
		has_main_web_app: false,
	} as never;
	vi.spyOn(bot.api, "sendMessage").mockResolvedValue({ message_id: 100 } as never);
	const sendChatAction = vi.spyOn(bot.api, "sendChatAction").mockResolvedValue(true as never);
	return { bot, session, sendChatAction, listeners, prompts };
}

describe("Telegram typing indicator", () => {
	it("starts as soon as the message is received, before the session exists", async () => {
		vi.useFakeTimers();
		try {
			let openGate: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
			const { bot, session, sendChatAction, prompts } = typingHarness({ sessionGate: gate });

			await bot.handleUpdate(messageUpdate(1, 1, "hello"));
			await vi.advanceTimersByTimeAsync(0);

			expect(sendChatAction).toHaveBeenCalledWith(1, "typing");
			expect(session.submit).not.toHaveBeenCalled();

			openGate();
			await vi.advanceTimersByTimeAsync(0);
			// Turn Settlement is the session's job now; the adapter only supplies the owner's own text.
			expect(session.submit).toHaveBeenCalledWith(
				expect.objectContaining({ text: "hello", settlementText: "hello" }),
				expect.any(Function),
			);
			prompts[0]?.();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops re-sending once the turn has finished", async () => {
		vi.useFakeTimers();
		try {
			const { bot, sendChatAction, prompts } = typingHarness();

			await bot.handleUpdate(messageUpdate(1, 1, "hello"));
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(3000);
			expect(sendChatAction).toHaveBeenCalledTimes(2);

			prompts[0]?.();
			await vi.advanceTimersByTimeAsync(0);
			const callsAtEnd = sendChatAction.mock.calls.length;
			await vi.advanceTimersByTimeAsync(20_000);
			expect(sendChatAction).toHaveBeenCalledTimes(callsAtEnd);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one indicator between the running turn and a queued message", async () => {
		vi.useFakeTimers();
		try {
			const { bot, sendChatAction, prompts } = typingHarness();

			await bot.handleUpdate(messageUpdate(1, 1, "first"));
			await vi.advanceTimersByTimeAsync(0);
			await bot.handleUpdate(messageUpdate(2, 2, "second"));
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(3000);

			// One at receipt plus one tick: a second timer for the queued message would make it 3.
			expect(sendChatAction).toHaveBeenCalledTimes(2);

			prompts[0]?.();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(3000);
			// Still typing for the queued message after the first turn ended.
			expect(sendChatAction.mock.calls.length).toBeGreaterThan(2);

			prompts[1]?.();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-sends right after the bot's first status message clears it", async () => {
		vi.useFakeTimers();
		try {
			const { bot, sendChatAction, listeners, prompts } = typingHarness();

			await bot.handleUpdate(messageUpdate(1, 1, "run something"));
			await vi.advanceTimersByTimeAsync(0);
			const before = sendChatAction.mock.calls.length;

			for (const listener of listeners) {
				listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} });
			}
			await vi.advanceTimersByTimeAsync(0);

			expect(sendChatAction.mock.calls.length).toBe(before + 1);

			prompts[0]?.();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("logs a failing indicator once per interval instead of swallowing it", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { bot, sendChatAction, prompts } = typingHarness();
			sendChatAction.mockRejectedValue(new Error("Too Many Requests"));

			await bot.handleUpdate(messageUpdate(1, 1, "hello"));
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(9000);

			const typingErrors = errorSpy.mock.calls.filter((call) => String(call[0]).includes("typing indicator failed"));
			expect(typingErrors).toHaveLength(1);
			expect(String(typingErrors[0]?.[1])).toContain("Too Many Requests");

			prompts[0]?.();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			errorSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("replyText", () => {
	function replyUpdate(replyToMessage: Record<string, unknown>): { message: { reply_to_message: unknown } } {
		return { message: { reply_to_message: replyToMessage } } as never;
	}

	it("returns undefined when there is no reply", () => {
		expect(replyText({ message: {} } as never)).toBeUndefined();
	});

	it("reads .text from a classic reply", () => {
		expect(replyText(replyUpdate({ text: "hello" }) as never)).toBe("hello");
	});

	it("falls back to .caption when .text is absent", () => {
		expect(replyText(replyUpdate({ caption: "a photo caption" }) as never)).toBe("a photo caption");
	});

	// Bot API 10.1 rich messages (sendRichMessage/rich editMessageText) come back on
	// reply_to_message with no .text/.caption at all - only a rich_message.blocks tree. Payload
	// shape below is exactly what a live reply to a rich-sent theoses answer returned.
	it("flattens rich_message.blocks when .text/.caption are absent", () => {
		const richMessage = {
			blocks: [
				{ type: "paragraph", text: "No need — already ran and finished. Summary:" },
				{
					type: "list",
					items: [
						{
							label: "•",
							blocks: [
								{
									type: "paragraph",
									text: [
										{ type: "bold", text: "Sync succeeded:" },
										" 3 posts synced across daily-quote, daily-jokes, github-repo-highlight, workplace-drama.",
									],
								},
							],
						},
						{
							label: "•",
							blocks: [
								{
									type: "paragraph",
									text: [
										{
											type: "bold",
											text: [{ type: "url", text: "learnings.md", url: "learnings.md" }, " regenerated"],
										},
										" for all 4 workspaces (fresh insight files the posting jobs read tomorrow).",
									],
								},
							],
						},
						{
							label: "•",
							blocks: [
								{ type: "paragraph", text: "Crontab is live again for tomorrow's automatic 21:30 KUL run." },
							],
						},
					],
				},
				{ type: "paragraph", text: "Nothing left to do tonight, abah." },
			],
		};

		const result = replyText(replyUpdate({ rich_message: richMessage }) as never);
		expect(result).toContain("No need — already ran and finished. Summary:");
		expect(result).toContain(
			"Sync succeeded: 3 posts synced across daily-quote, daily-jokes, github-repo-highlight, workplace-drama.",
		);
		expect(result).toContain("learnings.md regenerated");
		expect(result).toContain("Nothing left to do tonight, abah.");
	});

	it("returns undefined for an empty or malformed rich_message", () => {
		expect(replyText(replyUpdate({ rich_message: {} }) as never)).toBeUndefined();
		expect(replyText(replyUpdate({ rich_message: { blocks: [] } }) as never)).toBeUndefined();
	});
});

describe("parseModelCommand", () => {
	it("returns undefined for non-/model messages", () => {
		expect(parseModelCommand("hello")).toBeUndefined();
		expect(parseModelCommand("/modeling something")).toBeUndefined();
	});

	it("returns an empty string for bare /model", () => {
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("  /model  ")).toBe("");
	});

	it("returns the trimmed argument for /model <ref>", () => {
		expect(parseModelCommand("/model deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
		expect(parseModelCommand("/model   z-ai/glm-5.3-flash  ")).toBe("z-ai/glm-5.3-flash");
	});
});

describe("Telegram photo albums", () => {
	it("handles every photo in an album as one turn, using the album caption", async () => {
		const { bot, session, prompts } = typingHarness();
		vi.spyOn(bot.api, "getFile").mockResolvedValue({ file_id: "f", file_unique_id: "u", file_path: "p.jpg" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
		);
		const photoUpdate = (id: number, caption?: string): Update =>
			({
				update_id: id,
				message: {
					message_id: id,
					date: 1,
					chat: { id: 1, type: "private" },
					from: { id: 1, is_bot: false, first_name: "Owner" },
					media_group_id: "album-1",
					photo: [{ file_id: `photo-${id}`, file_unique_id: `u${id}`, width: 1, height: 1 }],
					...(caption ? { caption } : {}),
				},
			}) as Update;

		try {
			await bot.handleUpdate(photoUpdate(1));
			await bot.handleUpdate(photoUpdate(2, "compare these"));
			await bot.handleUpdate(photoUpdate(3));
			await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
			prompts[0]?.();

			const [input] = session.submit.mock.calls[0];
			expect(input.text).toBe("compare these");
			expect(input.images).toHaveLength(3);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Telegram turn that ends on a provider error", () => {
	function failedTurnHarness() {
		const harness = typingHarness();
		const outbound: string[] = [];
		harness.bot.api.config.use(async (_prev, method, payload) => {
			const p = payload as { text?: string; rich_message?: { markdown?: string } };
			outbound.push(`${method}: ${p.rich_message?.markdown ?? p.text ?? ""}`);
			return { ok: true, result: { message_id: 101 } } as never;
		});
		vi.mocked(harness.bot.api.sendMessage).mockImplementation(async (_chat, text) => {
			outbound.push(`sendMessage: ${text}`);
			return { message_id: 100 } as never;
		});
		const emit = (event: unknown) => {
			for (const listener of harness.listeners) listener(event);
		};
		// Replays the 2026-09-24 incident: narration + tool call, then every retry of the next turn errors.
		const failTurn = (narration?: string): PromptResult => {
			if (narration) {
				emit({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: narration }], stopReason: "toolUse" },
				});
				emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} });
				emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: {}, isError: false });
			}
			return {
				outcome: "failed",
				finalError: {
					message: "Provider timed out after 41191ms",
					provider: "openrouter",
					model: "xiaomi/mimo-v2.6-pro",
				},
			};
		};
		return { ...harness, outbound, failTurn };
	}

	it("shows the error after earlier narration and resumes once", async () => {
		vi.useFakeTimers();
		try {
			const { bot, session, prompts, outbound, failTurn } = failedTurnHarness();

			await bot.handleUpdate(messageUpdate(1, 1, "Pr the skip-list"));
			await vi.advanceTimersByTimeAsync(0);
			prompts[0]?.(failTurn("Now proving it works - scratch DB test before any commit:"));
			await vi.advanceTimersByTimeAsync(0);

			const reply = outbound.at(-1) ?? "";
			expect(reply).toContain("Now proving it works");
			expect(reply).toContain("openrouter/xiaomi/mimo-v2.6-pro failed: Provider timed out after 41191ms");
			expect(reply).toContain("Resuming automatically in 60s");

			await vi.advanceTimersByTimeAsync(60_000);
			expect(session.submit).toHaveBeenCalledTimes(2);
			expect(String(session.submit.mock.calls[1]?.[0].text)).toContain("[automatic resume]");

			// The resume fails too: reported, but not resumed again.
			prompts[1]?.(failTurn());
			await vi.advanceTimersByTimeAsync(0);
			expect(outbound.at(-1)).toContain("failed: Provider timed out");
			expect(outbound.at(-1)).not.toContain("Resuming automatically");
			await vi.advanceTimersByTimeAsync(120_000);
			expect(session.submit).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the pending resume when the owner sends a message", async () => {
		vi.useFakeTimers();
		try {
			const { bot, session, prompts, failTurn } = failedTurnHarness();

			await bot.handleUpdate(messageUpdate(1, 1, "Pr the skip-list"));
			await vi.advanceTimersByTimeAsync(0);
			prompts[0]?.(failTurn());
			await vi.advanceTimersByTimeAsync(0);

			await bot.handleUpdate(messageUpdate(2, 2, "Proceed"));
			await vi.advanceTimersByTimeAsync(0);
			prompts[1]?.();
			await vi.advanceTimersByTimeAsync(120_000);

			expect(session.submit.mock.calls.map((call) => call[0].text)).toEqual(["Pr the skip-list", "Proceed"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("inbound rich messages", () => {
	// Block shape of the lost 2026-09-24 report: paragraphs around a table. The table's key names are
	// not documented, so the walker must keep text from any shape.
	const report = {
		blocks: [
			{ type: "paragraph", text: [{ type: "bold", text: "Mini Pharmacy Stock Reduction Report" }] },
			{ type: "paragraph", text: "The following medicines were returned from the Mini Pharmacy:" },
			{
				type: "table",
				rows: [
					{ cells: [{ text: "Medicine" }, { text: "Qty" }] },
					{ cells: [{ text: "Paracetamol 500mg" }, { text: "20 boxes" }] },
				],
			},
			{ type: "paragraph", text: "Following this adjustment, the Mini Pharmacy will keep two boxes." },
		],
	};

	it("sends a rich message's text to the model instead of an empty prompt", async () => {
		const { bot, session, prompts } = typingHarness();
		await bot.handleUpdate({
			update_id: 1,
			message: {
				message_id: 1,
				date: 1,
				chat: { id: 1, type: "private" },
				from: { id: 1, is_bot: false, first_name: "Owner" },
				rich_message: report,
			},
		} as unknown as Update);
		await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(1));
		prompts[0]?.();

		const prompt = String(session.submit.mock.calls[0]?.[0].text);
		expect(prompt).toContain("Mini Pharmacy Stock Reduction Report\nThe following medicines were returned");
		expect(prompt).toContain("Paracetamol 500mg");
		expect(prompt).toContain("20 boxes");
		expect(prompt).toContain("Following this adjustment");
	});

	it("keeps text from block types it does not know when quoted", () => {
		const result = replyText({ message: { reply_to_message: { rich_message: report } } } as never);
		expect(result).toContain("Paracetamol 500mg");
		expect(result).not.toContain("table");
	});
});
