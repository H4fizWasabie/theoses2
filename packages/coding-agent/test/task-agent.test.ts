import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, EventStream, getModel } from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { runTask, TASK_AGENT_TOOLS, TASK_CAPS } from "../src/core/task-agent.ts";

class MockAssistantStream extends EventStream<
	| { type: "start"; partial: AssistantMessage }
	| { type: "done"; reason: string; message: AssistantMessage }
	| { type: "error"; reason: string; error: AssistantMessage },
	AssistantMessage
> {
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

function assistant(
	text: string,
	toolCall?: { id: string; name: string; args: Record<string, unknown> },
): AssistantMessage {
	return {
		role: "assistant",
		content: toolCall
			? [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.args }]
			: [{ type: "text", text }],
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
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

/** A model runtime that plays one scripted assistant message per turn and records what the sub-agent was given. */
function scripted(script: (turn: number) => AssistantMessage) {
	const seen: { systemPrompt?: string; toolNames: string[]; prompts: string[] } = { toolNames: [], prompts: [] };
	let turn = 0;
	const runtime = {
		getModel: () => getModel("anthropic", "claude-sonnet-4-5"),
		streamSimple: (
			_model: unknown,
			context: {
				systemPrompt?: string;
				tools?: Array<{ name: string }>;
				messages: Array<{ role: string; content: unknown }>;
			},
		) => {
			turn++;
			if (turn === 1) {
				seen.systemPrompt = context.systemPrompt;
				seen.toolNames = (context.tools ?? []).map((tool) => tool.name);
				seen.prompts = context.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
			}
			const message = script(turn);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	} as unknown as ModelRuntime;
	return { runtime, seen };
}

describe("task sub-agent", () => {
	let cwd: string;
	const model = getModel("anthropic", "claude-sonnet-4-5");

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "task-agent-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const run = (runtime: ModelRuntime, extra: Partial<Parameters<typeof runTask>[0]> = {}) =>
		runTask({ prompt: "fix the thing", cwd, model, thinkingLevel: "off", modelRuntime: runtime, ...extra });

	it("returns only the final summary, not what the sub-agent read on the way", async () => {
		writeFileSync(join(cwd, "big.txt"), "SECRET-FILE-CONTENT\n");
		const { runtime } = scripted((turn) =>
			turn === 1
				? assistant("", { id: "c1", name: "read", args: { path: "big.txt" } })
				: assistant("Changed nothing. Checked big.txt: fine."),
		);

		const result = await run(runtime);

		expect(result.complete).toBe(true);
		expect(result.answer).toContain("Changed nothing. Checked big.txt: fine.");
		expect(result.answer).not.toContain("SECRET-FILE-CONTENT");
	});

	it("starts from the brief alone, with no recursion into other sub-agent tools", async () => {
		const { runtime, seen } = scripted(() => assistant("done"));

		await run(runtime, { prompt: "brief: rename foo to bar" });

		expect(seen.prompts).toHaveLength(1);
		expect(seen.prompts[0]).toContain("brief: rename foo to bar");
		expect([...seen.toolNames].sort()).toEqual([...TASK_AGENT_TOOLS].sort());
		expect(seen.toolNames).not.toContain("task");
		expect(seen.toolNames).not.toContain("explore");
	});

	it("can change files", async () => {
		writeFileSync(join(cwd, "a.txt"), "old\n");
		const { runtime } = scripted((turn) =>
			turn === 1
				? assistant("", {
						id: "c1",
						name: "edit",
						args: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
					})
				: assistant("Edited a.txt."),
		);

		await run(runtime);

		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("new\n");
	});

	it("runs every tool call through the parent's gate, and a blocked call changes nothing", async () => {
		writeFileSync(join(cwd, "a.txt"), "old\n");
		const gated: string[] = [];
		const { runtime } = scripted((turn) =>
			turn === 1
				? assistant("", {
						id: "c1",
						name: "edit",
						args: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
					})
				: assistant("Could not edit."),
		);

		await run(runtime, {
			beforeToolCall: async ({ toolCall }) => {
				gated.push(toolCall.name);
				return { block: true, reason: "blocked by owner hook" };
			},
		});

		expect(gated).toEqual(["edit"]);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("old\n");
	});

	it("reports INCOMPLETE when it runs out of turns and writes nothing on its last turn", async () => {
		writeFileSync(join(cwd, "a.txt"), "x\n");
		const { runtime } = scripted((turn) => assistant("", { id: `c${turn}`, name: "read", args: { path: "a.txt" } }));

		const result = await run(runtime);

		expect(result.complete).toBe(false);
		expect(result.answer).toMatch(/^INCOMPLETE:/);
		expect(result.answer).toContain(`hit its ${TASK_CAPS.maxTurns}-turn cap and wrote no summary`);
		expect(result.stoppedBy).toEqual([`${TASK_CAPS.maxTurns}-turn cap`]);
		expect(result.turnsUsed).toBe(TASK_CAPS.maxTurns + 1);
	});

	it("gives a task cut off by its cap one last turn to say what is done, and returns that", async () => {
		writeFileSync(join(cwd, "a.txt"), "x\n");
		const { runtime } = scripted((turn) =>
			turn <= TASK_CAPS.maxTurns
				? assistant("", { id: `c${turn}`, name: "read", args: { path: "a.txt" } })
				: assistant("Edited a.txt. Tests not run."),
		);

		const result = await run(runtime);

		expect(result.complete).toBe(false);
		expect(result.answer).toMatch(/^INCOMPLETE:/);
		expect(result.answer).toContain(`${TASK_CAPS.maxTurns}-turn cap`);
		expect(result.answer).toContain("git diff");
		expect(result.answer).toContain("Edited a.txt. Tests not run.");
		expect(result.stoppedBy).toEqual([`${TASK_CAPS.maxTurns}-turn cap`]);
		expect(result.turnsUsed).toBe(TASK_CAPS.maxTurns + 1);
	});

	it("keeps a summary written on the last allowed turn as complete", async () => {
		writeFileSync(join(cwd, "a.txt"), "x\n");
		const { runtime } = scripted((turn) =>
			turn < TASK_CAPS.maxTurns
				? assistant("", { id: `c${turn}`, name: "read", args: { path: "a.txt" } })
				: assistant("Done: nothing to change."),
		);

		const result = await run(runtime);

		expect(result.complete).toBe(true);
		expect(result.answer).toBe("Done: nothing to change.");
		expect(result.turnsUsed).toBe(TASK_CAPS.maxTurns);
	});

	it("caps a long summary", async () => {
		const long = Array.from({ length: TASK_CAPS.lines + 20 }, (_, i) => `line ${i}`).join("\n");
		const { runtime } = scripted(() => assistant(long));

		const result = await run(runtime);

		expect(result.answer.split("\n").length).toBeLessThanOrEqual(TASK_CAPS.lines + 1);
		expect(result.answer).toContain("truncated by harness");
	});
});
