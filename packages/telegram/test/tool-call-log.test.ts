import { describe, expect, it } from "vitest";
import { createToolCallLogger } from "../src/tool-call-log.ts";

function harness() {
	let t = 1000;
	const lines: string[] = [];
	const logger = createToolCallLogger(
		() => t,
		(line) => lines.push(line),
	);
	return {
		logger,
		lines,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("createToolCallLogger", () => {
	it("logs an ok call with its duration and no detail", () => {
		const { logger, lines, advance } = harness();
		logger.start("c1");
		advance(412);
		logger.end({
			toolCallId: "c1",
			toolName: "procura_search",
			result: { content: [{ type: "text", text: "rows" }] },
			isError: false,
		});
		expect(lines).toEqual(["[tool] procura_search ok 412ms"]);
	});

	it("logs an error with the first 200 characters of the result text on one line", () => {
		const { logger, lines, advance } = harness();
		logger.start("c2");
		advance(88);
		logger.end({
			toolCallId: "c2",
			toolName: "social_metrics_sync",
			result: { content: [{ type: "text", text: `social_metrics_sync failed:\n${"x".repeat(400)}` }] },
			isError: true,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[tool\] social_metrics_sync error 88ms: social_metrics_sync failed: x+$/);
		expect(lines[0]?.split(": ").slice(1).join(": ").length).toBeLessThanOrEqual(200);
		expect(lines[0]).not.toContain("\n");
	});

	it("shows ? when the start was never seen and accepts a plain-string result", () => {
		const { logger, lines } = harness();
		logger.end({ toolCallId: "nope", toolName: "bash", result: "boom", isError: true });
		expect(lines).toEqual(["[tool] bash error ?ms: boom"]);
	});
});
