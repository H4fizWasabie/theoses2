import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, EventStream, getModel } from "theoses-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { createResearchToolDefinition, RESEARCH_CAPS, ResearchJobs, runResearch } from "../src/core/researcher.ts";

class MockStream extends EventStream<
	{ type: "start" | "done"; partial?: AssistantMessage; reason?: string; message?: AssistantMessage },
	AssistantMessage
> {
	constructor() {
		super(
			(event) => event.type === "done",
			(event) => event.message as AssistantMessage,
		);
	}
}

function assistant(text: string): AssistantMessage {
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
	};
}

/** Answers with each text in turn (the last one repeats), so a test can script narration then a report. */
function fakeRuntime(...texts: string[]): ModelRuntime {
	let call = 0;
	return {
		getModel: () => getModel("anthropic", "claude-sonnet-4-5")!,
		streamSimple: () => {
			const message = assistant(texts[Math.min(call++, texts.length - 1)]);
			const stream = new MockStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	} as unknown as ModelRuntime;
}

describe("researcher", () => {
	let dir: string;
	const savedAgentDir = process.env.THEOSES_CODING_AGENT_DIR;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "theoses-research-test-"));
		process.env.THEOSES_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.THEOSES_CODING_AGENT_DIR;
		else process.env.THEOSES_CODING_AGENT_DIR = savedAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the report of a finished job", async () => {
		const result = await runResearch({
			question: "q",
			modelRuntime: fakeRuntime("Summary\nAnswer https://a.example"),
		});
		expect(result.complete).toBe(true);
		expect(result.report).toContain("https://a.example");
	});

	it("asks for the final report when the model ends on narration, not a report", async () => {
		const result = await runResearch({
			question: "q",
			modelRuntime: fakeRuntime(
				"I have substantial information. Let me extract a few pages.",
				"Summary\nThe real answer",
			),
		});
		expect(result.complete).toBe(true);
		expect(result.report).toContain("The real answer");
		expect(result.turnsUsed).toBe(2);
	});

	it("marks the job incomplete when the model still writes no report", async () => {
		const result = await runResearch({
			question: "q",
			modelRuntime: fakeRuntime("Let me look at a few more pages."),
		});
		expect(result.complete).toBe(false);
		expect(result.report).toContain("INCOMPLETE");
	});

	it("blocks until the job finishes and returns the report, also saved to a file", async () => {
		const jobs = new ResearchJobs();
		const tool = createResearchToolDefinition({ modelRuntime: fakeRuntime("Summary\nAnswer"), jobs });
		const result = await tool.execute("id", { question: "what is x?" }, undefined, undefined, undefined as never);
		const text = JSON.stringify(result.content);
		expect(text).toContain("Research job r1 finished");
		expect(text).toContain("Answer");
		expect(jobs.running).toBe(0);
		expect(readdirSync(join(dir, "research"))).toHaveLength(1);
	});

	it("refuses beyond the concurrency and per-session limits", async () => {
		const jobs = new ResearchJobs();
		const tool = createResearchToolDefinition({ modelRuntime: fakeRuntime("x"), jobs });
		const run = () => tool.execute("id", { question: "q" }, undefined, undefined, undefined as never);

		jobs.running = RESEARCH_CAPS.maxConcurrent;
		expect(JSON.stringify((await run()).content)).toContain("already running");

		jobs.running = 0;
		jobs.started = RESEARCH_CAPS.maxPerSession;
		expect(JSON.stringify((await run()).content)).toContain("already used");
	});
});
