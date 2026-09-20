import type { AssistantMessage } from "theoses-ai";
import { isStopWithHiddenOutput, summarizeStreamChunk } from "theoses-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logServedProvider } from "../src/core/served-provider-log.ts";

const base = { stopReason: "stop", toolCallCount: 0, outputTokens: 509, reasoningTokens: 0, visibleChars: 145 };

describe("isStopWithHiddenOutput", () => {
	it("flags the 2026-09-20 Relace stall: 509 tokens billed for 145 characters and no tool call", () => {
		expect(isStopWithHiddenOutput(base)).toBe(true);
	});

	it("ignores normal turns", () => {
		expect(isStopWithHiddenOutput({ ...base, toolCallCount: 1 })).toBe(false);
		expect(isStopWithHiddenOutput({ ...base, stopReason: "toolUse" })).toBe(false);
		expect(isStopWithHiddenOutput({ ...base, outputTokens: 60, visibleChars: 200 })).toBe(false);
		expect(isStopWithHiddenOutput({ ...base, outputTokens: 498, visibleChars: 1500 })).toBe(false);
	});

	it("does not count reasoning tokens as unexplained", () => {
		expect(isStopWithHiddenOutput({ ...base, reasoningTokens: 480 })).toBe(false);
	});
});

describe("summarizeStreamChunk", () => {
	it("keeps only delta keys and sizes, never the text", () => {
		const line = summarizeStreamChunk({
			choices: [{ delta: { content: "secret text", tool_calls: [{}] }, finish_reason: "stop" }],
			usage: { completion_tokens: 509 },
		});
		expect(line).toBe("{content:11,tool_calls:1items} finish=stop completion_tokens=509");
		expect(line).not.toContain("secret");
	});
});

describe("logServedProvider stall report", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.THEOSES_BACKGROUND_FAILURE_LOG;
	});

	it("logs a [stall] line when the message carries the diagnostic", () => {
		process.env.THEOSES_BACKGROUND_FAILURE_LOG = "/nonexistent-dir-for-test/x/y/z.jsonl";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Now the collector" }],
			model: "z-ai/glm-5.3-flash",
			responseProvider: "Relace",
			stopReason: "stop",
			usage: { output: 509 },
			diagnostics: [
				{ type: "stop_without_tool_call_hidden_output", timestamp: 0, details: { chunkTail: ["{content:5}"] } },
			],
		} as unknown as AssistantMessage;
		logServedProvider(message);
		expect(
			errorSpy.mock.calls.some((c) => String(c[0]).startsWith("[stall] turn ended with stop and no tool call")),
		).toBe(true);
	});
});
