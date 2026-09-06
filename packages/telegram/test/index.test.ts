import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("theoses-coding-agent", () => ({
	SessionManager: {
		list: vi.fn(),
		create: vi.fn(),
		open: vi.fn(),
	},
	createAgentSession: vi.fn(),
	maybeRunConsolidation: vi.fn(),
}));

import { createAgentSession, SessionManager } from "theoses-coding-agent";
import { createTelegramBot } from "../src/index.ts";

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
