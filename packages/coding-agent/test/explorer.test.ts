import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, EventStream, getModel } from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExploreToolDefinition, resetExplorerConcurrencyForTests, runExplorer } from "../src/core/explorer.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

// ---------------------------------------------------------------------------
// Scripted model: a fake ModelRuntime whose streamSimple replays a scripted
// sequence of assistant messages per turn — same idiom as agent-session-retry.
// ---------------------------------------------------------------------------

class MockAssistantStream extends EventStream<AssistantMessageEventShape, AssistantMessage> {
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

type AssistantMessageEventShape =
	| { type: "start"; partial: AssistantMessage }
	| { type: "done"; reason: string; message: AssistantMessage }
	| { type: "error"; reason: string; error: AssistantMessage };

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1000,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function toolCallMessage(id: string, tool: string): AssistantMessage {
	return createAssistantMessage("", {
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "" },
			{ type: "toolCall", id, name: tool, arguments: {} },
		],
	});
}

type ScriptStep = (turn: number) => AssistantMessage;

function createFakeModelRuntime(script: ScriptStep): { runtime: ModelRuntime; turns: () => number } {
	let turn = 0;
	const runtime = {
		getModel: () => getModel("anthropic", "claude-sonnet-4-5")!,
		streamSimple: () => {
			turn++;
			const message = script(turn);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	} as unknown as ModelRuntime;
	return { runtime, turns: () => turn };
}

const FINAL_ANSWER = `Retry logic lives in packages/ai/src/api/retry.ts:42, exponential backoff, 3 attempts max.
Rate-limit errors take a dedicated path at retry.ts:78.
Config knob: maxRetries in settings.
~1K in, 2/8 turns`;

describe("explorer (issue #254)", () => {
	let tempDir: string;

	beforeEach(() => {
		resetExplorerConcurrencyForTests();
		tempDir = mkdtempSync(join(tmpdir(), "theoses-explorer-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs the read-only tool loop and returns the distilled answer with a footer", async () => {
		const script: ScriptStep = (turn) =>
			turn === 1 ? toolCallMessage("call_1", "ls") : createAssistantMessage(FINAL_ANSWER);
		const { runtime } = createFakeModelRuntime(script);
		const statuses: string[] = [];

		const result = await runExplorer({
			question: "where is retry logic?",
			cwd: tempDir,
			modelRuntime: runtime,
			onStatus: (status) => statuses.push(status),
		});

		expect(result.complete).toBe(true);
		expect(result.turnsUsed).toBe(2);
		expect(result.answer).toContain("retry.ts:42");
		// The explorer emitted its own footer; no duplicate appended.
		expect(result.answer).toContain("~1K in, 2/8 turns");
		// Status updates streamed for the tool activity.
		expect(statuses.some((status) => status.includes("ls"))).toBe(true);
	});

	it("truncates an oversized answer at the tier's line cap", async () => {
		const longAnswer = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		const { runtime } = createFakeModelRuntime(() => createAssistantMessage(longAnswer));

		const result = await runExplorer({ question: "map it", cwd: tempDir, modelRuntime: runtime });

		expect(result.complete).toBe(true);
		expect(result.answer).toContain("[truncated by harness: exceeded quick-scan cap of 30 lines]");
		// 30 capped content lines + 1 truncation notice + 1 budget footer.
		expect(result.answer.split("\n").length).toBeLessThanOrEqual(32);
	});

	it("appends the budget footer when the explorer forgot it", async () => {
		const { runtime } = createFakeModelRuntime(() => createAssistantMessage("The answer is in foo/bar.ts:12."));

		const result = await runExplorer({ question: "where?", cwd: tempDir, modelRuntime: runtime });

		expect(result.complete).toBe(true);
		expect(result.answer).toContain("The answer is in foo/bar.ts:12.");
		expect(result.answer).toMatch(/~\d+K in, \d+\/8 turns$/);
	});

	it("stops at the turn cap and returns the INCOMPLETE contract instead of a guess", async () => {
		let turn = 0;
		const { runtime, turns } = createFakeModelRuntime(() => {
			turn++;
			return toolCallMessage(`call_${turn}`, "ls");
		});

		const result = await runExplorer({
			question: "map everything",
			tier: "quick-scan",
			cwd: tempDir,
			modelRuntime: runtime,
		});

		expect(turns()).toBe(8); // quick-scan turn ceiling reached, loop stopped
		expect(result.complete).toBe(false);
		expect(result.maxTurns).toBe(8);
		expect(result.answer).toContain("INCOMPLETE:");
		expect(result.answer).toMatch(/\d+\/8 turns$/);
	});

	it("caps concurrent explorers at 3", async () => {
		let active = 0;
		let maxActive = 0;
		let activePeak = 0;
		const gates: Array<() => void> = [];

		const { runtime } = {
			runtime: {
				getModel: () => getModel("anthropic", "claude-sonnet-4-5")!,
				streamSimple: () => {
					active++;
					maxActive = Math.max(maxActive, active);
					activePeak = maxActive;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						// Each explorer stays "in-flight" until its gate opens.
						const release = new Promise<void>((resolve) => gates.push(resolve));
						void release.then(() => {
							active--;
							const message = createAssistantMessage("done answer. ~1K in, 1/8 turns");
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: "stop", message });
						});
					});
					return stream;
				},
			} as unknown as ModelRuntime,
		};

		const runs = [1, 2, 3, 4].map((i) =>
			runExplorer({ question: `question ${i}`, cwd: tempDir, modelRuntime: runtime }),
		);

		// Yield until the semaphore blocks the 4th spawn: only 3 streams may have started.
		await new Promise((resolve) => setImmediate(resolve));
		expect(activePeak).toBe(3);

		// Open gates round by round: releasing the first 3 lets the 4th spawn start, whose
		// own gate then needs opening too. Drain until all four explorers have finished.
		for (let round = 0; round < 8 && resultsIncomplete(); round++) {
			while (gates.length > 0) gates.shift()!();
			await new Promise((resolve) => setImmediate(resolve));
		}
		function resultsIncomplete(): boolean {
			return gates.length > 0;
		}
		const results = await Promise.all(runs);
		expect(results).toHaveLength(4);
		expect(results.every((result) => result.complete)).toBe(true);
	});

	it("exposes the explore tool with the agreed schema", async () => {
		const definition = createExploreToolDefinition({
			cwd: tempDir,
			modelRuntime: createFakeModelRuntime(() => createAssistantMessage("answer. ~1K in, 1/8 turns")).runtime,
		});
		expect(definition.name).toBe("explore");
		const result = await definition.execute("id-1", { question: "where is X?" }, undefined, undefined, {} as never);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("answer");
	});
});
