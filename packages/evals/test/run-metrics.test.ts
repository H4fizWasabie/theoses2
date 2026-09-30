import { describe, expect, it } from "vitest";
import { measureToolUse } from "../src/run-metrics.ts";

type Messages = Parameters<typeof measureToolUse>[0];

const LONG = "line of file content that is long enough to count as evidence. ".repeat(3);

let nextId = 0;
function call(name: string, args: Record<string, unknown>) {
	nextId += 1;
	return { type: "toolCall", id: `c${nextId}`, name, arguments: args };
}
const assistant = (stopReason: string, ...calls: ReturnType<typeof call>[]) =>
	({ role: "assistant", stopReason, content: calls }) as unknown as Messages[number];
const result = (toolCall: ReturnType<typeof call>, text: string, isError = false) =>
	({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		isError,
		content: [{ type: "text", text }],
	}) as unknown as Messages[number];

describe("measureToolUse", () => {
	it("counts rounds, calls and how the run ended", () => {
		const read = call("read", { path: "a.mjs" });
		const stats = measureToolUse([assistant("toolUse", read), result(read, LONG), assistant("stop")]);
		expect(stats).toMatchObject({ rounds: 2, toolCalls: 1, toolErrors: 0, terminationReason: "stop" });
	});

	it("counts an exact repeat of a read-only call as a duplicate, whatever the argument order", () => {
		const first = call("read", { path: "a.mjs", limit: 10 });
		const again = call("read", { limit: 10, path: "a.mjs" });
		const stats = measureToolUse([
			assistant("toolUse", first),
			result(first, LONG),
			assistant("toolUse", again),
			result(again, LONG),
			assistant("stop"),
		]);
		expect(stats).toMatchObject({ duplicateCalls: 1, noNewEvidenceCalls: 0 });
	});

	it("counts a different call that returns the same text as no new evidence, not also as a duplicate", () => {
		const whole = call("read", { path: "a.mjs" });
		const ranged = call("read", { path: "a.mjs", offset: 1 });
		const stats = measureToolUse([
			assistant("toolUse", whole),
			result(whole, LONG),
			assistant("toolUse", ranged),
			result(ranged, LONG),
			assistant("stop"),
		]);
		expect(stats).toMatchObject({ duplicateCalls: 0, noNewEvidenceCalls: 1 });
	});

	it("does not count a re-read after an edit, or any repeat of a bash command", () => {
		const first = call("read", { path: "a.mjs" });
		const edit = call("edit", { path: "a.mjs" });
		const verify = call("read", { path: "a.mjs" });
		const test1 = call("bash", { command: "node --test" });
		const test2 = call("bash", { command: "node --test" });
		const stats = measureToolUse([
			assistant("toolUse", first),
			result(first, LONG),
			assistant("toolUse", edit),
			result(edit, "ok"),
			assistant("toolUse", verify),
			result(verify, LONG),
			assistant("toolUse", test1),
			result(test1, "fail"),
			assistant("toolUse", test2),
			result(test2, "pass"),
			assistant("stop"),
		]);
		expect(stats).toMatchObject({ duplicateCalls: 0, noNewEvidenceCalls: 0, toolCalls: 5 });
	});

	it("does not count a search that finds nothing twice, or a retry after a failed call", () => {
		const grep1 = call("grep", { pattern: "foo" });
		const grep2 = call("grep", { pattern: "bar" });
		const missing = call("read", { path: "nope.mjs" });
		const retry = call("read", { path: "nope.mjs" });
		const stats = measureToolUse([
			assistant("toolUse", grep1),
			result(grep1, "No matches found"),
			assistant("toolUse", grep2),
			result(grep2, "No matches found"),
			assistant("toolUse", missing),
			result(missing, "ENOENT", true),
			assistant("toolUse", retry),
			result(retry, LONG),
			assistant("stop"),
		]);
		expect(stats).toMatchObject({ duplicateCalls: 0, noNewEvidenceCalls: 0, toolErrors: 1 });
	});

	it("reports the stop reason of the last assistant message when the run did not finish cleanly", () => {
		expect(measureToolUse([assistant("stop"), assistant("length")]).terminationReason).toBe("length");
		expect(measureToolUse([]).terminationReason).toBe("none");
	});
});
