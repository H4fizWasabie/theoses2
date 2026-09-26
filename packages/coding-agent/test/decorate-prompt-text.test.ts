import { describe, expect, test } from "vitest";
import { decoratePromptText } from "../src/core/agent-session.ts";

describe("decoratePromptText", () => {
	test("prefixes the Abort Notice when the last operation was aborted", () => {
		const result = decoratePromptText("hello", "aborted", undefined, "");
		expect(result).toMatch(/^\[Abort Notice:/);
		expect(result).toContain("hello");
	});

	test("prefixes the Interrupted Notice when the last operation was interrupted", () => {
		const result = decoratePromptText("hello", "interrupted", undefined, "");
		expect(result).toMatch(/^\[Interrupted Notice:/);
		expect(result).toContain("hello");
	});

	test("adds no notice for a completed, failed, or unknown last outcome", () => {
		expect(decoratePromptText("hello", "completed", undefined, "")).toBe("hello");
		expect(decoratePromptText("hello", "failed", undefined, "")).toBe("hello");
		expect(decoratePromptText("hello", undefined, undefined, "")).toBe("hello");
	});

	test("preserves quoted reply context and the clock annotation", () => {
		const result = decoratePromptText("hello", undefined, "earlier message", " [clock]");
		expect(result).toBe("[Quoted message context]\nearlier message\n[/Quoted message context]\n\nhello [clock]");
	});

	test("combines the Abort Notice, reply context, and clock annotation in order", () => {
		const result = decoratePromptText("hello", "aborted", "earlier message", " [clock]");
		expect(result.startsWith("[Abort Notice:")).toBe(true);
		expect(result).toContain("[Quoted message context]\nearlier message\n[/Quoted message context]\n\nhello [clock]");
	});
});
