import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it, vi } from "vitest";
import { effectiveCap, MIN_PRUNING_CAP_CHARS, pruneFinishedTurnOutputs } from "../src/core/context-pruning.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResult(text: string, overrides: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	} as AgentMessage;
}

function assistantWithCall(args: Record<string, unknown>, name = "write", id = "call_a"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Writing the file." },
			{ type: "toolCall", id, name, arguments: args },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	} as AgentMessage;
}

function text(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("not a tool result");
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

const CAPS = { toolResultMaxChars: 1500, toolCallArgsMaxChars: 1500 };
const long = (length: number, fill = "x") => fill.repeat(length);

describe("pruneFinishedTurnOutputs: tool results", () => {
	it("cuts a result over the cap to a head, a marker and a tail", () => {
		const raw = `START${long(5000, "m")}END`;

		const { messages, stats } = pruneFinishedTurnOutputs([toolResult(raw)], CAPS);
		const cut = text(messages[0]);

		expect(cut.length).toBeLessThan(1500);
		expect(cut.startsWith("START")).toBe(true);
		expect(cut.endsWith("END")).toBe(true);
		expect(cut).toMatch(/\[\.\.\. \d+ chars omitted from this earlier bash output/);
		expect(stats.toolResults).toBe(1);
		expect(stats.charsRemoved).toBe(raw.length - cut.length);
	});

	it("leaves results at or under the cap exactly as they are", () => {
		const atCap = toolResult(long(1500));
		const small = toolResult("ok");

		const { messages, stats } = pruneFinishedTurnOutputs([atCap, small], CAPS);

		expect(messages[0]).toBe(atCap);
		expect(messages[1]).toBe(small);
		expect(stats).toEqual({ toolResults: 0, toolCallArguments: 0, charsRemoved: 0 });
	});

	it("returns the same array when nothing changed", () => {
		const input = [toolResult("ok")];

		expect(pruneFinishedTurnOutputs(input, CAPS).messages).toBe(input);
	});

	it("keeps the error flag, ids and details, and leaves images alone", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const message = toolResult(long(4000), {
			isError: true,
			toolCallId: "call_keep",
			details: { exitCode: 2 },
			content: [{ type: "text", text: long(4000) }, image],
		});

		const cut = pruneFinishedTurnOutputs([message], CAPS).messages[0];

		expect(cut).toMatchObject({
			role: "toolResult",
			isError: true,
			toolCallId: "call_keep",
			details: { exitCode: 2 },
		});
		if (cut.role !== "toolResult") throw new Error("unexpected role");
		expect(cut.content.at(-1)).toEqual(image);
		expect(cut.content.filter((block) => block.type === "text")).toHaveLength(1);
	});

	it("counts the text of several blocks together", () => {
		const message = toolResult("", {
			content: [
				{ type: "text", text: long(1000) },
				{ type: "text", text: long(1000) },
			],
		});

		expect(pruneFinishedTurnOutputs([message], CAPS).stats.toolResults).toBe(1);
	});

	it("saves the full text under a stable name and puts the path in the marker", () => {
		const raw = long(5000, "z");
		const spill = vi.fn((_name: string, _text: string) => "/session/artifacts/pruned-result-call_1.txt");

		const cut = text(pruneFinishedTurnOutputs([toolResult(raw)], { ...CAPS, spill }).messages[0]);

		expect(spill).toHaveBeenCalledWith("result-call_1.txt", raw);
		expect(cut).toContain(
			"full text saved at /session/artifacts/pruned-result-call_1.txt, read it with the read tool",
		);
	});

	it("still cuts, without a path, when the text cannot be saved", () => {
		const cut = text(
			pruneFinishedTurnOutputs([toolResult(long(5000))], { ...CAPS, spill: () => undefined }).messages[0],
		);

		expect(cut).toContain("chars omitted from this earlier bash output");
		expect(cut).not.toContain("full text saved at");
	});

	it("makes a filesystem-safe file name from an unusual tool call id", () => {
		const spill = vi.fn((_name: string, _text: string): string | undefined => undefined);

		pruneFinishedTurnOutputs([toolResult(long(5000), { toolCallId: "call_abc|weird/../id?" })], { ...CAPS, spill });

		expect(spill.mock.calls[0][0]).toBe("result-call_abc_weird_id_.txt");
	});

	it("is deterministic and idempotent, so repeated requests send identical text", () => {
		const input = [toolResult(long(9000)), assistantWithCall({ path: "a.ts", content: long(9000) })];

		const first = pruneFinishedTurnOutputs(input, { ...CAPS, spill: () => "/p/x.txt" });
		const again = pruneFinishedTurnOutputs(input, { ...CAPS, spill: () => "/p/x.txt" });
		const twice = pruneFinishedTurnOutputs(first.messages, { ...CAPS, spill: () => "/p/x.txt" });

		expect(again.messages).toEqual(first.messages);
		expect(twice.messages).toBe(first.messages);
		expect(twice.stats).toEqual({ toolResults: 0, toolCallArguments: 0, charsRemoved: 0 });
	});

	it("stays idempotent at the smallest allowed cap, where the marker is longer than the excerpt", () => {
		const options = {
			toolResultMaxChars: 400,
			toolCallArgsMaxChars: 400,
			spill: () => "/a/long/path/to/an/artifact/file.txt",
		};
		const first = pruneFinishedTurnOutputs([toolResult(long(3000))], options);

		expect(pruneFinishedTurnOutputs(first.messages, options).messages).toBe(first.messages);
	});

	it("does not touch user, assistant text or thinking", () => {
		const user = { role: "user", content: [{ type: "text", text: long(9000) }], timestamp: 1 } as AgentMessage;
		const assistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: long(9000) },
				{ type: "text", text: long(9000) },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage,
			stopReason: "stop",
			timestamp: 1,
		} as AgentMessage;

		const { messages } = pruneFinishedTurnOutputs([user, assistant], CAPS);

		expect(messages[0]).toBe(user);
		expect(messages[1]).toBe(assistant);
	});
});

describe("pruneFinishedTurnOutputs: tool-call arguments", () => {
	it("cuts a long string inside the arguments and keeps their shape", () => {
		const args = { path: "src/a.ts", content: `HEAD${long(6000, "c")}TAIL`, overwrite: true, retries: 3 };

		const { messages, stats } = pruneFinishedTurnOutputs([assistantWithCall(args)], CAPS);
		const call = (messages[0] as { content: Array<{ type: string; arguments?: Record<string, unknown> }> })
			.content[1];

		expect(Object.keys(call.arguments ?? {})).toEqual(["path", "content", "overwrite", "retries"]);
		expect(call.arguments).toMatchObject({ path: "src/a.ts", overwrite: true, retries: 3 });
		const content = String(call.arguments?.content);
		expect(content.startsWith("HEAD")).toBe(true);
		expect(content.endsWith("TAIL")).toBe(true);
		expect(content).toContain("chars omitted from this earlier write call");
		expect(stats.toolCallArguments).toBe(1);
		expect(stats.toolResults).toBe(0);
	});

	it("reaches strings nested in arrays and objects, leaving short ones alone", () => {
		const args = {
			edits: [
				{ oldText: "short", newText: long(4000) },
				{ oldText: long(4000), newText: "also short" },
			],
		};

		const { messages } = pruneFinishedTurnOutputs([assistantWithCall(args, "edit")], CAPS);
		const edits = (messages[0] as { content: Array<{ arguments?: { edits: Array<Record<string, string>> } }> })
			.content[1].arguments?.edits;

		expect(edits?.[0].oldText).toBe("short");
		expect(edits?.[0].newText).toContain("omitted from this earlier edit call");
		expect(edits?.[1].oldText).toContain("omitted from this earlier edit call");
		expect(edits?.[1].newText).toBe("also short");
	});

	it("saves the whole argument object once and points every cut at it", () => {
		const spill = vi.fn((_name: string, _text: string) => "/p/args.json");
		const args = { a: long(3000), b: long(3000) };

		const { messages } = pruneFinishedTurnOutputs([assistantWithCall(args, "write", "call_z")], { ...CAPS, spill });
		const cut = (messages[0] as { content: Array<{ arguments?: Record<string, string> }> }).content[1].arguments;

		expect(spill).toHaveBeenCalledTimes(1);
		expect(spill.mock.calls[0][0]).toBe("args-call_z.json");
		expect(JSON.parse(spill.mock.calls[0][1] as string)).toEqual(args);
		expect(cut?.a).toContain("full text saved at /p/args.json");
		expect(cut?.b).toContain("full text saved at /p/args.json");
	});

	it("leaves a call whose arguments are all short as the same object", () => {
		const message = assistantWithCall({ command: "ls -la" }, "bash");

		expect(pruneFinishedTurnOutputs([message], CAPS).messages[0]).toBe(message);
	});
});

describe("pruneFinishedTurnOutputs: settings", () => {
	it("cap 0 switches each kind off independently", () => {
		const input = [toolResult(long(5000)), assistantWithCall({ content: long(5000) })];

		const resultsOff = pruneFinishedTurnOutputs(input, { toolResultMaxChars: 0, toolCallArgsMaxChars: 1500 });
		const argsOff = pruneFinishedTurnOutputs(input, { toolResultMaxChars: 1500, toolCallArgsMaxChars: 0 });

		expect(resultsOff.stats).toMatchObject({ toolResults: 0, toolCallArguments: 1 });
		expect(argsOff.stats).toMatchObject({ toolResults: 1, toolCallArguments: 0 });
		expect(pruneFinishedTurnOutputs(input, { toolResultMaxChars: 0, toolCallArgsMaxChars: 0 }).messages).toBe(input);
	});

	it("raises a cap below the minimum instead of producing a marker larger than the text", () => {
		expect(effectiveCap(50)).toBe(MIN_PRUNING_CAP_CHARS);
		expect(effectiveCap(0)).toBe(0);
		expect(effectiveCap(-5)).toBe(0);
		expect(effectiveCap(Number.NaN)).toBe(0);
		expect(effectiveCap(2000.7)).toBe(2000);

		const input = [toolResult(long(300))];
		expect(pruneFinishedTurnOutputs(input, { toolResultMaxChars: 50, toolCallArgsMaxChars: 0 }).messages).toBe(input);
	});
});
