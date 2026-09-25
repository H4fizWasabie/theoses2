import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { type ChannelSession, createChannelSessions } from "../../src/core/channel-session.ts";

// Settlement runs memory consolidation against real stores; it has its own tests.
vi.mock("../../src/core/turn-settlement.ts", () => ({ settleTurn: vi.fn() }));

describe("Channel Session", () => {
	let root: string;
	let cwd: string;
	let faux: FauxProviderRegistration;
	const opened: ChannelSession[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	function writeAgentDir(settings: Record<string, unknown> = {}): void {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const model = faux.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: m.input })),
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, ...settings }),
		);
		process.env[ENV_AGENT_DIR] = agentDir;
	}

	function registry() {
		const sessions = createChannelSessions({ channel: "test", cwd });
		return {
			...sessions,
			async open(id: string, file?: string) {
				const session = await sessions.open(id, file);
				opened.push(session);
				return session;
			},
		};
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "theoses-channel-session-"));
		cwd = join(root, "work");
		mkdirSync(cwd);
		faux = registerFauxProvider({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: true },
			],
		});
		writeAgentDir();
	});

	afterEach(async () => {
		while (opened.length > 0) await opened.pop()?.stop();
		faux.unregister();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("reuses the open session and finds it on disk after a restart", async () => {
		faux.setResponses([fauxAssistantMessage("hello")]);
		const first = registry();
		const session = await first.open("chat-1");
		expect(await first.open("chat-1")).toBe(session);
		await session.submit({ text: "hi" });
		expect(first.list()).toEqual([session]);

		const restarted = registry();
		expect(restarted.list()).toEqual([]);
		const reopened = await restarted.open("chat-1");
		expect(reopened.sessionId).toBe(session.sessionId);
		expect((await restarted.open("chat-2")).sessionId).not.toBe(session.sessionId);
	});

	it("refuses a session file that belongs to another channel", async () => {
		faux.setResponses([fauxAssistantMessage("hello")]);
		const session = await registry().open("chat-1");
		await session.submit({ text: "hi" });
		const other = createChannelSessions({ channel: "other", cwd });
		await expect(other.open("chat-1", session.sessionFile)).rejects.toThrow("not a other session");
	});

	it.each([
		[{}, "high"],
		[{ defaultThinkingLevel: "low" }, "low"],
	])("applies settings %j as thinking level %s", async (settings, expected) => {
		writeAgentDir(settings);
		faux.setResponses([
			(_context, options) => fauxAssistantMessage(String((options as { reasoning?: string })?.reasoning)),
		]);
		const events: AgentSessionEvent[] = [];
		await (await registry().open("chat-1")).submit({ text: "hi" }, (event) => events.push(event));
		const end = events.find((event) => event.type === "message_end" && event.message.role === "assistant");
		expect(JSON.stringify(end)).toContain(expected);
	});

	it("runs submits one at a time, in order, each seeing only its own events", async () => {
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const session = await registry().open("chat-1");
		const seen: string[][] = [[], []];
		const texts = (index: number) => (event: AgentSessionEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				seen[index].push(JSON.stringify(event.message.content));
			}
		};
		const [a, b] = await Promise.all([
			session.submit({ text: "one" }, texts(0)),
			session.submit({ text: "two" }, texts(1)),
		]);
		expect([a?.outcome, b?.outcome]).toEqual(["completed", "completed"]);
		expect(seen[0].join()).toContain("first");
		expect(seen[1].join()).toContain("second");
		expect(seen[0].join()).not.toContain("second");
	});

	it("stop reports the running tool and the turn ends aborted", async () => {
		// After the aborted tool the loop requests once more with the aborted signal, and auth resolution
		// throws an AbortError before any provider code runs; lazyStream must report that as "aborted".
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
		]);
		const session = await registry().open("chat-1");
		let stop: Promise<{ wasRunning: boolean; runningTool?: string }> | undefined;
		const result = await session.submit({ text: "go" }, (event) => {
			if (event.type === "tool_execution_start") stop = session.stop();
		});
		expect(await stop).toEqual({ wasRunning: true, runningTool: "bash" });
		expect(result?.outcome).toBe("aborted");
		expect(session.isRunning).toBe(false);
	});

	it("stop on an idle session reports nothing running", async () => {
		const session = await registry().open("chat-1");
		expect(await session.stop()).toEqual({ wasRunning: false, runningTool: undefined });
	});

	it("switches to an exact model match and rejects anything else", async () => {
		const session = await registry().open("chat-1");
		const two = faux.getModel("two")!;
		const switched = await session.switchModel(`${two.provider}/${two.id}`);
		expect(switched).toEqual({ model: expect.objectContaining({ id: "two" }) });
		expect(session.model?.id).toBe("two");
		expect(await session.switchModel("nope/missing")).toEqual({
			error: 'No exact match for "nope/missing". Use the canonical provider/id.',
		});
	});

	it("returns the provider error of a failed turn", async () => {
		writeAgentDir({ retry: { enabled: false } });
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const result = await (await registry().open("chat-1")).submit({ text: "hi" });
		expect(result).toEqual({ outcome: "failed", finalError: expect.objectContaining({ message: "boom" }) });
	});
});
