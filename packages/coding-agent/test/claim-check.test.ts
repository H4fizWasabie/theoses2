import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it } from "vitest";
import { CLAIM_CHECK_CUSTOM_TYPE, claimCheck, FINAL_REPLY_NOTE, findClaimProblem } from "../src/core/claim-check.ts";

let nextId = 0;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function reply(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** One assistant tool call plus its result. */
function tool(name: string, args: Record<string, unknown>, output: string, isError = false): AgentMessage[] {
	const id = `call-${nextId++}`;
	const call = reply("");
	if (call.role === "assistant") call.content = [{ type: "toolCall", id, name, arguments: args }];
	return [
		call,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError,
			timestamp: 0,
		},
	];
}

describe("findClaimProblem", () => {
	it("A: flags a failed edit that was never retried (the 2026-09-26 run.sh case)", () => {
		const problem = findClaimProblem([
			user("switch run.sh to a single image"),
			...tool(
				"edit",
				{ path: "tools/run.sh" },
				"No changes applied: all 5 edits were rejected. Could not find edits[4]",
				true,
			),
			...tool("bash", { command: "sed -i '105d' tools/run.sh" }, ""),
			...tool("bash", { command: "bash tools/run.sh --dry-run" }, "[dry-run] nothing published"),
			reply("Done and verified — gate changed to exactly 1 image."),
		]);
		expect(problem).toContain("tools/run.sh");
		expect(problem).toContain("never successfully retried");
	});

	it("A: a later successful edit to the same path resolves the failure", () => {
		expect(
			findClaimProblem([
				user("fix it"),
				...tool("edit", { path: "a.ts" }, "Could not find the exact text", true),
				...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
				reply("Updated a.ts."),
			]),
		).toBeUndefined();
	});

	it("A: stays quiet when the reply already reports the failure", () => {
		expect(
			findClaimProblem([
				user("fix it"),
				...tool("edit", { path: "src/a.ts" }, "Could not find the exact text", true),
				reply("The edit to a.ts failed: the text changed. Want me to retry?"),
			]),
		).toBeUndefined();
	});

	it("B: flags a verification claim with no command after the last change", () => {
		const problem = findClaimProblem([
			user("fix it"),
			...tool("bash", { command: "npm test" }, "ok"),
			...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
			reply("Fixed and tested."),
		]);
		expect(problem).toContain("no check command ran after your last change (a.ts)");
	});

	it("B: flags a verification claim when the last command failed", () => {
		const problem = findClaimProblem([
			user("fix it"),
			...tool("write", { path: "a.ts" }, "Wrote a.ts"),
			...tool("bash", { command: "npm test" }, "1 failing\nCommand exited with code 1", true),
			reply("Fixed, tests pass."),
		]);
		expect(problem).toContain("last check after your changes failed: 1 failing");
	});

	it("B: a grep with no matches after the change is not a failed check", () => {
		expect(
			findClaimProblem([
				user("fix it"),
				...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
				...tool("bash", { command: "npm test" }, "all passed"),
				...tool("bash", { command: "grep -n oldName src/a.ts" }, "Command exited with code 1", true),
				reply("Fixed and verified."),
			]),
		).toBeUndefined();
	});

	it("B: a plan verify item takes over the evidence check", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
					reply("Fixed and tested."),
				],
				{ verifyCovered: true },
			),
		).toBeUndefined();
	});

	it("B: accepts a verification claim backed by a passing command", () => {
		expect(
			findClaimProblem([
				user("fix it"),
				...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
				...tool("bash", { command: "npm test" }, "all passed"),
				reply("Fixed and verified."),
			]),
		).toBeUndefined();
	});

	it("C: flags a done claim for a requested change with no tool calls", () => {
		expect(findClaimProblem([user("delete the old backup file"), reply("Done, deleted.")])).toContain(
			"no tool calls",
		);
	});

	it("C: ignores plain conversation", () => {
		expect(findClaimProblem([user("how are you?"), reply("All good, done for the day.")])).toBeUndefined();
	});
});

describe("claimCheck", () => {
	it("pushes back at most once per run", async () => {
		const run = [user("delete the old backup file"), reply("Done.")];
		const first = claimCheck(run);
		expect(first).toMatchObject({ role: "custom", customType: CLAIM_CHECK_CUSTOM_TYPE });
		// #389: the corrected reply replaces this one in Telegram, so it must be the full answer.
		expect(first?.content).toContain(FINAL_REPLY_NOTE);
		expect(claimCheck([...run, first as AgentMessage, reply("Done.")])).toBeUndefined();
	});
});
