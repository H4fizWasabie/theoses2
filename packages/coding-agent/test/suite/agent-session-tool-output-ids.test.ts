/**
 * Tool-output ids (#580, ADR-0013): every tool result starts with ⟨tN⟩ from the moment it is created, the session
 * log stores the same text the model is sent, and an id never changes once given.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "theoses-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "theoses-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { TASK_BOUNDARY_CUSTOM_TYPE, type TaskBoundaryData } from "../../src/core/task-boundary-detector.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function echoTool(name = "echo", delayMs = 0): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, params) => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return { content: [{ type: "text", text: `${name}:${(params as { value: string }).value}` }], details: {} };
		},
	};
}

function toolResults(messages: Context["messages"]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function firstText(message: ToolResultMessage): string {
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

describe("AgentSession tool-output ids", () => {
	const harnesses: Harness[] = [];
	/** The messages of every provider request, in order. */
	let sent: Context["messages"][] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		sent = [];
	});

	async function harnessWith(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({ tools: [echoTool()], ...options });
		harnesses.push(harness);
		return harness;
	}

	/** A response step that records the request it answers. */
	function respond(message: ReturnType<typeof fauxAssistantMessage>) {
		return (context: Context) => {
			sent.push(structuredClone(context.messages));
			return message;
		};
	}

	/** One user turn: the model calls `echo` once per value, then replies. */
	function toolTurn(...values: string[]) {
		return [
			respond(
				fauxAssistantMessage(
					values.map((value) => fauxToolCall("echo", { value })),
					{ stopReason: "toolUse" },
				),
			),
			respond(fauxAssistantMessage("done")),
		];
	}

	it("starts each tool result the model sees with its id, and logs the same text", async () => {
		const harness = await harnessWith();
		harness.setResponses(toolTurn("a"));

		await harness.session.prompt("run it");

		const [seen] = toolResults(sent[1]);
		expect(firstText(seen)).toBe("⟨t1⟩\necho:a");
		const logged = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(logged.map((message) => message.content)).toEqual([seen.content]);
	});

	it("numbers parallel calls in call order, not the order they finish in", async () => {
		const harness = await harnessWith({ tools: [echoTool("slow", 30), echoTool("fast"), echoTool()] });
		harness.setResponses([
			respond(
				fauxAssistantMessage(
					[
						fauxToolCall("slow", { value: "a" }),
						fauxToolCall("fast", { value: "b" }),
						fauxToolCall("missing", {}),
					],
					{ stopReason: "toolUse" },
				),
			),
			respond(fauxAssistantMessage("done")),
			...toolTurn("c"),
		]);

		await harness.session.prompt("run them");
		await harness.session.prompt("once more");

		// The call that never ran keeps its place in the numbering as a gap; the next turn goes on from there.
		expect(toolResults(sent[3]).map(firstText)).toEqual([
			"⟨t1⟩\nslow:a",
			"⟨t2⟩\nfast:b",
			"Tool missing not found",
			"⟨t4⟩\necho:c",
		]);
	});

	it("goes on numbering from the session log after the session is reopened", async () => {
		const first = await harnessWith({ persist: true });
		first.setResponses(toolTurn("a", "b"));
		await first.session.prompt("run it");
		const file = first.sessionManager.getSessionFile();
		if (!file) throw new Error("the session was not persisted");

		const reopened = await harnessWith({ sessionManager: SessionManager.open(file) });
		reopened.session.agent.state.messages = reopened.sessionManager.buildSessionContext().messages;
		reopened.setResponses(toolTurn("c"));
		await reopened.session.prompt("again");

		expect(toolResults(sent[3]).map(firstText)).toEqual(["⟨t1⟩\necho:a", "⟨t2⟩\necho:b", "⟨t3⟩\necho:c"]);
	});

	it("keeps the id at the start of a result that turn-start pruning cut", async () => {
		const harness = await harnessWith();
		harness.setResponses([...toolTurn("x".repeat(5000)), respond(fauxAssistantMessage("ok"))]);

		await harness.session.prompt("print a lot");
		await harness.session.prompt("and now?");

		const [pruned] = toolResults(sent[2]);
		expect(firstText(pruned)).toMatch(/^⟨t1⟩\necho:x+\n\n\[\.\.\. \d+ chars omitted from this earlier echo output/);
	});

	it("saves an evicted result under its id, and the marker names the id, the path and the head and tail", async () => {
		const harness = await harnessWith({ persist: true });
		harness.setResponses([...toolTurn("x".repeat(5000)), respond(fauxAssistantMessage("ok"))]);

		await harness.session.prompt("print a lot");
		await harness.session.prompt("and now?");

		const marker = firstText(toolResults(sent[2])[0]);
		const saved = join(harness.sessionManager.getArtifactDirectory(), "pruned-result-t1.txt");
		expect(marker).toMatch(
			/^⟨t1⟩\necho:x+\n\n\[\.\.\. \d+ chars omitted from this earlier echo output ⟨t1⟩; full text saved at /,
		);
		expect(marker).toContain(`full text saved at ${saved}, read it with the read tool`);
		expect(marker).toMatch(/x\n\n\[\.\.\. [^\n]*\]\n\nx+$/);
		expect(readFileSync(saved, "utf8")).toBe(`echo:${"x".repeat(5000)}`);
	});

	it("lets the model read a saved result back with offset and limit, as the original text", async () => {
		const value = `${"a".repeat(3000)}\nSECOND LINE\n${"b".repeat(3000)}`;
		const harness = await harnessWith({ persist: true });
		harness.setResponses([...toolTurn(value), respond(fauxAssistantMessage("ok"))]);

		await harness.session.prompt("print two lines");
		await harness.session.prompt("and now?");

		const saved = join(harness.sessionManager.getArtifactDirectory(), "pruned-result-t1.txt");
		const read = await createReadTool(harness.sessionManager.getArtifactDirectory()).execute("read-back", {
			path: saved,
			offset: 2,
			limit: 1,
		});
		expect(read.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("SECOND LINE") });
	});

	it("keeps numbering after a log rotation whose kept tail holds no tool result, and keeps the saved files", async () => {
		const first = await harnessWith({ persist: true });
		const oldArtifacts = first.sessionManager.getArtifactDirectory();
		first.setResponses([...toolTurn("x".repeat(5000), "b"), respond(fauxAssistantMessage("ok"))]);
		await first.session.prompt("print a lot");
		await first.session.prompt("and now?");
		const oldSaved = join(oldArtifacts, "pruned-result-t1.txt");
		// The first turn is promoted and the compaction keeps from the last user message: the tail starts there.
		const branch = first.sessionManager.getBranch();
		const isUser = (entry: (typeof branch)[number]) => entry.type === "message" && entry.message.role === "user";
		const lastUser = branch.findLastIndex(isUser);
		first.sessionManager.appendPromotedRange(branch[0].id, branch[lastUser - 1].id);
		first.sessionManager.appendCompaction("summary", branch[lastUser].id, 1000);
		const newFile = first.sessionManager.rotate() as string;
		const kept = first.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(kept).toEqual([]); // precondition: the tail the rotation keeps has no tool result

		const reopened = await harnessWith({ sessionManager: SessionManager.open(newFile) });
		reopened.session.agent.state.messages = reopened.sessionManager.buildSessionContext().messages;
		reopened.setResponses([...toolTurn("y".repeat(5000)), respond(fauxAssistantMessage("ok"))]);
		await reopened.session.prompt("again");
		await reopened.session.prompt("and then?");

		expect(firstText(toolResults(sent[4])[0])).toMatch(/^⟨t3⟩\necho:y/);
		const newSaved = join(reopened.sessionManager.getArtifactDirectory(), "pruned-result-t3.txt");
		expect(readFileSync(newSaved, "utf8")).toBe(`echo:${"y".repeat(5000)}`);
		expect(readFileSync(oldSaved, "utf8")).toBe(`echo:${"x".repeat(5000)}`);
	});

	it("leaves surviving results their ids after a task reset, and does not reuse the dropped ones", async () => {
		const harness = await harnessWith({ settings: { compaction: { keepRecentTokens: 100_000 } } });
		harness.setResponses([...toolTurn("a"), ...toolTurn("b"), ...toolTurn("c")]);
		await harness.session.prompt("first task");
		await harness.session.prompt("second task");
		const secondTask = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")[1];
		harness.sessionManager.appendCustomEntry(TASK_BOUNDARY_CUSTOM_TYPE, {
			taskSummary: "second task",
			beforeEntryId: secondTask.id,
		} satisfies TaskBoundaryData);

		await harness.session.compact();
		await harness.session.prompt("go on");

		expect(toolResults(sent[5]).map(firstText)).toEqual(["⟨t2⟩\necho:b", "⟨t3⟩\necho:c"]);
	});

	it("keeps every request's messages a byte-identical prefix of the next one, within a turn and across turns", async () => {
		const harness = await harnessWith();
		harness.setResponses([...toolTurn("a", "b"), ...toolTurn("c"), ...toolTurn("d")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.prompt("three");

		expect(sent).toHaveLength(6);
		// Same check as the eval package's cache-prefix helper: where do two consecutive requests stop sharing messages?
		for (let i = 1; i < sent.length; i++) {
			const before = sent[i - 1].map((message) => JSON.stringify(message));
			const after = sent[i].map((message) => JSON.stringify(message));
			expect(after.slice(0, before.length), `request ${i}`).toEqual(before);
		}
		expect(toolResults(sent[5]).map(firstText)).toEqual([
			"⟨t1⟩\necho:a",
			"⟨t2⟩\necho:b",
			"⟨t3⟩\necho:c",
			"⟨t4⟩\necho:d",
		]);
	});
});
