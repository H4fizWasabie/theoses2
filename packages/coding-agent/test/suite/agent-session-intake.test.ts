import type { AgentTool } from "theoses-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MID_TASK_NOTE } from "../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

/**
 * A steered or follow-up message goes through the same intake as a prompt: the owner's UserPromptSubmit hooks,
 * extension input handlers, expansion. It joins the running operation, so it carries no Abort Notice, and a steer
 * is marked as sent mid-task. The run waits for a message still in intake, so it always lands in that run.
 */
describe("AgentSession intake for queued messages", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A session whose first prompt ("start") blocks in a `wait` tool until released. */
	async function waiting(hooks: Record<string, Array<Record<string, unknown>>> = {}) {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool], settings: { hooks } });
		harnesses.push(harness);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const callWait = fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" });
		return { harness, release, toolStarted, callWait };
	}

	it("runs the owner's UserPromptSubmit hooks on a steered message and marks it as sent mid-task", async () => {
		const { harness, release, toolStarted, callWait } = await waiting({
			UserPromptSubmit: [{ command: `grep -q check-this && echo '{"additionalContext":"from the hook"}'; exit 0` }],
		});
		harness.setResponses([callWait, fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		await expect(harness.session.steer("check-this")).resolves.toBe(true);
		release();
		await run;

		expect(getUserTexts(harness)[1]).toBe(`${MID_TASK_NOTE}\ncheck-this\n\n[Context from hooks]\nfrom the hook`);
	});

	it("drops a steered message a hook blocks, and says why", async () => {
		const { harness, release, toolStarted, callWait } = await waiting({
			UserPromptSubmit: [{ command: "grep -q block-me && { echo 'not now' >&2; exit 2; }; exit 0" }],
		});
		harness.setResponses([callWait, fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		await expect(harness.session.followUp("block-me")).resolves.toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(JSON.stringify(harness.session.messages)).toContain("A hook blocked this prompt: not now");
	});

	it("gives a steered message no Abort Notice, though the prompt that started the run has one", async () => {
		const { harness, release, toolStarted, callWait } = await waiting();
		harness.sessionManager.appendOperationFinished("aborted");
		harness.setResponses([callWait, fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		await harness.session.steer("more");
		release();
		await run;

		const [first, steered] = getUserTexts(harness);
		expect(first).toContain("[Abort Notice:");
		expect(steered).toBe(`${MID_TASK_NOTE}\nmore`);
	});

	it("removes each of two identical queued texts once, as each is delivered", async () => {
		const { harness, release, toolStarted, callWait } = await waiting();
		harness.session.setSteeringMode("one-at-a-time");
		const countsAtDelivery: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && getMessageText(event.message) === `${MID_TASK_NOTE}\nsame`) {
				countsAtDelivery.push(harness.session.pendingMessageCount);
			}
		});
		harness.setResponses([callWait, fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		await harness.session.steer("same");
		await harness.session.steer("same");
		expect(harness.session.getSteeringMessages()).toEqual(["same", "same"]);
		release();
		await run;

		expect(countsAtDelivery).toEqual([1, 0]);
	});

	it("keeps the run going until a steered message whose hook is still running is queued, then delivers it", async () => {
		const { harness, release, toolStarted, callWait } = await waiting({
			UserPromptSubmit: [{ command: "grep -q slow-hook && sleep 0.5; exit 0" }],
		});
		harness.setResponses([callWait, fauxAssistantMessage("first done"), fauxAssistantMessage("handled the steer")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		const steering = harness.session.steer("slow-hook");
		// The tool returns and the model answers while the hook still sleeps, so the run would end here.
		release();
		await run;

		await expect(steering).resolves.toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", `${MID_TASK_NOTE}\nslow-hook`]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("drops a message still in intake when the queue is cleared, as /stop does", async () => {
		const { harness, release, toolStarted, callWait } = await waiting({
			UserPromptSubmit: [{ command: "grep -q slow-hook && sleep 0.3; exit 0" }],
		});
		harness.setResponses([callWait, fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");

		await toolStarted;
		const steering = harness.session.steer("slow-hook");
		harness.session.clearQueue();
		release();
		await run;

		await expect(steering).resolves.toBe(false);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});
});
