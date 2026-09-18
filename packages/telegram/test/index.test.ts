import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("theoses-coding-agent", () => ({
	SessionManager: {
		list: vi.fn(),
		create: vi.fn(),
		open: vi.fn(),
	},
	createAgentSession: vi.fn(),
	// Intent router (issue #268): default to off in tests so no Jev path is exercised.
	classifyUrgency: vi.fn(async () => ({ mode: "off", isUrgent: false })),
	urgentIntakeNotice: vi.fn(() => "[intake: test URGENT notice]"),
	maybeRunConsolidation: vi.fn(),
	maybeDetectTaskBoundary: vi.fn(),
	findLastUserMessageEntryId: vi.fn(),
	configureHttpDispatcher: vi.fn(),
	findExactModelReferenceMatch: vi.fn(),
	getAgentDir: vi.fn(() => "/tmp/telegram-test-agent-dir"),
	DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
		return { reload: vi.fn() };
	}),
}));

import { classifyUrgency, createAgentSession, SessionManager, urgentIntakeNotice } from "theoses-coding-agent";
import { createTelegramBot, parseModelCommand, replyText } from "../src/index.ts";

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
		let streaming = false;
		const sessionManager = {
			getChannelSessionKey: () => ({ channel: "telegram", channelSessionId: "1" }),
			getCwd: () => "/tmp/telegram-test",
		};
		const session = {
			get isStreaming() {
				return streaming;
			},
			prompt: vi.fn(async () => {
				streaming = true;
				await new Promise<void>((resolve) => {
					releasePrompt = resolve;
				});
			}),
			abort: vi.fn(async () => {
				streaming = false;
				releasePrompt?.();
			}),
			subscribe: vi.fn(() => () => {}),
			getActiveToolNames: vi.fn(() => []),
			setActiveToolsByName: vi.fn(),
			sessionManager,
			modelRuntime: {},
		};

		vi.mocked(SessionManager.list).mockResolvedValue([]);
		vi.mocked(SessionManager.create).mockReturnValue(sessionManager as never);
		vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

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
		await vi.waitFor(() => expect(session.isStreaming).toBe(true));
		const queued = bot.handleUpdate(messageUpdate(2, 2, "queued message"));
		const stopped = bot.handleUpdate(messageUpdate(3, 3, "/stop"));

		await stopped;
		await Promise.all([active, queued]);

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(1, expect.stringContaining("Also skipped your next queued message."));
	});
});

describe("Telegram update dispatch", () => {
	it("returns from the update handler without waiting for a long-running turn to finish (issue #209)", async () => {
		let releasePrompt: (() => void) | undefined;
		let promptResolved = false;
		const sessionManager = {
			getChannelSessionKey: () => ({ channel: "telegram", channelSessionId: "1" }),
			getCwd: () => "/tmp/telegram-test",
		};
		const session = {
			isStreaming: false,
			prompt: vi.fn(async () => {
				await new Promise<void>((resolve) => {
					releasePrompt = resolve;
				});
				promptResolved = true;
			}),
			abort: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			getActiveToolNames: vi.fn(() => []),
			setActiveToolsByName: vi.fn(),
			sessionManager,
			modelRuntime: {},
		};

		vi.mocked(SessionManager.list).mockResolvedValue([]);
		vi.mocked(SessionManager.create).mockReturnValue(sessionManager as never);
		vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

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
		// waitFor: the queued turn now also awaits the intent-router promise (issue #268), so the
		// prompt call lands one microtask tick later than when this test was written.
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		expect(promptResolved).toBe(false);

		releasePrompt?.();
		await vi.waitFor(() => expect(promptResolved).toBe(true));
	});
});

function botHarness(releasePrompt: { resolve: () => void } | undefined = undefined) {
	const sessionManager = {
		getChannelSessionKey: () => ({ channel: "telegram", channelSessionId: "1" }),
		getCwd: () => "/tmp/telegram-test",
	};
	const session = {
		isStreaming: false,
		prompt: vi.fn(async (_text: string) => {
			if (releasePrompt) {
				await new Promise<void>((resolve) => {
					releasePrompt.resolve = resolve;
				});
			}
		}),
		abort: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		getActiveToolNames: vi.fn(() => []),
		setActiveToolsByName: vi.fn(),
		sessionManager,
		modelRuntime: {},
	};
	vi.mocked(SessionManager.list).mockResolvedValue([]);
	vi.mocked(SessionManager.create).mockReturnValue(sessionManager as never);
	vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

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
	return { bot, session };
}

describe("Intent-router prompt stamping (issue #268)", () => {
	it("prepends the urgent intake notice when the classifier stamps a message", async () => {
		const release: { resolve: () => void } = { resolve: () => {} };
		const { bot, session } = botHarness(release);
		vi.mocked(classifyUrgency).mockResolvedValue({ mode: "on", isUrgent: true, probability: 0.9 });

		await bot.handleUpdate(messageUpdate(1, 2, "the server is down"));
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		expect(String(session.prompt.mock.calls[0]?.[0])).toBe(`${urgentIntakeNotice()}\n\nthe server is down`);
		release.resolve();
	});

	it("passes normal messages through unchanged", async () => {
		const { bot, session } = botHarness();
		vi.mocked(classifyUrgency).mockResolvedValue({ mode: "on", isUrgent: false, probability: 0.1 });

		await bot.handleUpdate(messageUpdate(1, 3, "haha good one"));
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		expect(String(session.prompt.mock.calls[0]?.[0])).toBe("haha good one");
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
