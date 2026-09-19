import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * A real AgentSession prompt with a stubbed model: what the model is sent for a new turn must have
 * the previous turns' oversized tool output cut, while the session log keeps the original.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "theoses-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	getModel,
} from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

const BIG_OUTPUT = `OUT-HEAD${"o".repeat(8000)}OUT-TAIL`;
const BIG_ARG = `ARG-HEAD${"a".repeat(8000)}ARG-TAIL`;

/** One finished turn: the user asks, the assistant runs a tool with a big argument and gets a big result. */
function finishedTurn(): AgentMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "run the thing" }], timestamp: 1 },
		assistant(
			[{ type: "toolCall", id: "call_old", name: "write", arguments: { path: "out.txt", content: BIG_ARG } }],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId: "call_old",
			toolName: "bash",
			content: [{ type: "text", text: BIG_OUTPUT }],
			isError: false,
			timestamp: 2,
		},
		assistant([{ type: "text", text: "Done, it printed a lot." }]),
	];
}

describe("AgentSession prunes finished-turn tool output before a new turn", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theoses-context-pruning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(options: { settings?: Partial<Settings>; persist?: boolean } = {}) {
		const sent: Context["messages"][] = [];
		const seeded = finishedTurn();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: "Test",
				tools: [],
				messages: seeded,
			},
			streamFn: (_model, context) => {
				sent.push(structuredClone(context.messages));
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant([]) });
					stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "ok" }]) });
				});
				return stream;
			},
		});
		const sessionManager = options.persist
			? SessionManager.create(tempDir, join(tempDir, "sessions"))
			: SessionManager.inMemory(tempDir);
		// The log holds the same messages the agent starts with, as it would after a real earlier turn.
		for (const message of seeded)
			sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(options.settings ?? {}),
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		return { session, sent, sessionManager };
	}

	const toolResultText = (messages: Context["messages"]): string => {
		const result = messages.find((message) => message.role === "toolResult");
		if (!result || result.role !== "toolResult") throw new Error("no tool result was sent");
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	};

	const toolCallArguments = (messages: Context["messages"]): Record<string, string> => {
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content)
				if (block.type === "toolCall") return block.arguments as Record<string, string>;
		}
		throw new Error("no tool call was sent");
	};

	it("sends the model a cut tool result and cut tool-call arguments for the finished turn", async () => {
		const { session: s, sent } = await createSession();

		await s.prompt("next question");

		expect(sent).toHaveLength(1);
		const result = toolResultText(sent[0]);
		expect(result.length).toBeLessThan(1500);
		expect(result.startsWith("OUT-HEAD")).toBe(true);
		expect(result.endsWith("OUT-TAIL")).toBe(true);
		expect(result).toContain("chars omitted from this earlier bash output");
		const args = toolCallArguments(sent[0]);
		expect(args.path).toBe("out.txt");
		expect(args.content.length).toBeLessThan(1500);
		expect(args.content).toContain("chars omitted from this earlier write call");
		// The new turn's own user message is sent as written.
		expect(JSON.stringify(sent[0].at(-1))).toContain("next question");
	});

	it("leaves the session log with the original, uncut text", async () => {
		const { session: s, sessionManager } = await createSession();

		await s.prompt("next question");

		const logged = JSON.stringify(sessionManager.getEntries());
		expect(logged).toContain(BIG_OUTPUT);
		expect(logged).toContain(BIG_ARG);
	});

	it("sends the same cut text on every later turn, so the prompt prefix does not move", async () => {
		const { session: s, sent } = await createSession();

		await s.prompt("first follow-up");
		await s.prompt("second follow-up");

		expect(sent).toHaveLength(2);
		expect(toolResultText(sent[1])).toBe(toolResultText(sent[0]));
		expect(toolCallArguments(sent[1])).toEqual(toolCallArguments(sent[0]));
	});

	it("does not cut anything when both caps are 0", async () => {
		const { session: s, sent } = await createSession({
			settings: { contextPruning: { toolResultMaxChars: 0, toolCallArgsMaxChars: 0 } },
		});

		await s.prompt("next question");

		expect(toolResultText(sent[0])).toBe(BIG_OUTPUT);
		expect(toolCallArguments(sent[0]).content).toBe(BIG_ARG);
	});

	it("honours a configured cap", async () => {
		const { session: s, sent } = await createSession({
			settings: { contextPruning: { toolResultMaxChars: 3000, toolCallArgsMaxChars: 0 } },
		});

		await s.prompt("next question");

		const result = toolResultText(sent[0]);
		expect(result.length).toBeGreaterThan(1500);
		expect(result.length).toBeLessThan(3000);
		expect(toolCallArguments(sent[0]).content).toBe(BIG_ARG);
	});

	it("saves the full text where the model can read it, without listing it in the artifact catalog", async () => {
		const { session: s, sent, sessionManager } = await createSession({ persist: true });

		await s.prompt("next question");

		const marker = toolResultText(sent[0]).match(/full text saved at (\S+?), read it with the read tool/);
		expect(marker).not.toBeNull();
		const savedPath = marker?.[1] ?? "";
		expect(savedPath).toContain("pruned-result-call_old.txt");
		expect(readFileSync(savedPath, "utf8")).toBe(BIG_OUTPUT);
		expect(sessionManager.getArtifactCatalog()).not.toContain("pruned-");
	});
});
