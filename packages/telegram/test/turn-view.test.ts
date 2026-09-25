import type { AgentSessionEvent } from "theoses-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createTurnView, extractGeneratedImages, type MessageFormat, type Outbox } from "../src/turn-view.ts";

vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

/** Records every call as one line; `fail` lists "send:rich"-style calls Telegram should reject. */
function recordingOutbox(fail: string[] = []) {
	const calls: string[] = [];
	let nextId = 100;
	const attempt = (call: string, format: MessageFormat) => {
		if (fail.includes(`${call}:${format}`)) throw new Error(`${call} ${format} rejected`);
	};
	const outbox: Outbox = {
		async send(text, format, replyTo) {
			attempt("send", format);
			const id = nextId++;
			calls.push(`send ${format} #${id} ->${replyTo}: ${text}`);
			return id;
		},
		async edit(messageId, text, format) {
			attempt("edit", format);
			calls.push(`edit ${format} #${messageId}: ${text}`);
		},
		async delete(messageId) {
			calls.push(`delete #${messageId}`);
		},
		async sendPhotos(images) {
			calls.push(`photos ${images.length}`);
		},
	};
	return { outbox, calls };
}

const toolStart = (toolName: string, id = "t1") =>
	({
		type: "tool_execution_start",
		toolCallId: id,
		toolName,
		args: { command: "ls" },
	}) as unknown as AgentSessionEvent;
const toolEnd = (toolName: string, id = "t1", result: unknown = {}) =>
	({ type: "tool_execution_end", toolCallId: id, toolName, result, isError: false }) as unknown as AgentSessionEvent;
const answer = (text: string) =>
	({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	}) as unknown as AgentSessionEvent;
const failure = {
	outcome: "failed" as const,
	finalError: { provider: "openrouter", model: "x/y", message: "timed out" },
};

describe("Turn View", () => {
	it("turns the tool status message into the answer", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(toolStart("bash"));
		view.onEvent(toolEnd("bash"));
		view.onEvent(answer("done"));
		await view.finish({ outcome: "completed" });
		expect(calls).toEqual(["send plain #100 ->7: Running bash...", "edit rich #100: done"]);
	});

	it("falls back from rich to HTML to plain when editing the status, then to a fresh threaded send", async () => {
		const edits = recordingOutbox(["edit:rich", "edit:html"]);
		const view = createTurnView(edits.outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(toolStart("bash"));
		view.onEvent(answer("done"));
		await view.finish({ outcome: "completed" });
		expect(edits.calls.at(-1)).toMatch(/^edit plain #100: done/);

		const sends = recordingOutbox(["edit:rich", "edit:html", "edit:plain", "send:rich"]);
		const fresh = createTurnView(sends.outbox, { replyTo: 7, toolCallDetail: false });
		fresh.onEvent(toolStart("bash"));
		fresh.onEvent(answer("done"));
		await fresh.finish({ outcome: "completed" });
		expect(sends.calls.at(-1)).toMatch(/^send html #101 ->7: done/);
	});

	it("threads each section of a multi-part reply to the previous one", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(answer("first\n\n---\n\nsecond"));
		await view.finish({ outcome: "completed" });
		expect(calls).toEqual(["send rich #100 ->7: first", "send rich #101 ->100: second"]);
	});

	it("keeps the tool-call block in detail mode and sends the answer separately", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: true });
		view.onEvent(toolStart("bash"));
		view.onEvent(toolEnd("bash"));
		view.onEvent(answer("done"));
		await view.finish({ outcome: "completed" });
		expect(calls[0]).toMatch(/^send rich #100 ->7: /);
		expect(calls[1]).toMatch(/^edit rich #100: /);
		expect(calls.at(-1)).toBe("send rich #101 ->7: done");
		expect(calls.filter((call) => call.includes("done"))).toHaveLength(1);
	});

	it("turns the status into the provider error, with the resume hint when a resume is scheduled", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(toolStart("bash"));
		await view.finish(failure, { resumeInMs: 60_000 });
		expect(calls.at(-1)).toBe(
			"edit plain #100: openrouter/x/y failed: timed out\nResuming automatically in 60s. Send any message to cancel.",
		);
	});

	it("sends the provider error as a reply when there is no status, and appends it to narration", async () => {
		const bare = recordingOutbox();
		await createTurnView(bare.outbox, { replyTo: 7, toolCallDetail: false }).finish(failure);
		expect(bare.calls).toEqual(["send plain #100 ->7: openrouter/x/y failed: timed out"]);

		const narrated = recordingOutbox();
		const view = createTurnView(narrated.outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(answer("Now proving it works"));
		await view.finish(failure);
		expect(narrated.calls.at(-1)).toBe(
			"send rich #100 ->7: Now proving it works\n\nopenrouter/x/y failed: timed out",
		);
	});

	it("drops a halted turn's output and its status message", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(toolStart("bash"));
		view.onEvent(answer("partial"));
		await view.finish({ outcome: "aborted" });
		expect(calls).toEqual(["send plain #100 ->7: Running bash...", "delete #100"]);
	});

	it("deletes the status when the turn ends with nothing to say", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		view.onEvent(toolStart("bash"));
		await view.finish({ outcome: "completed" });
		expect(calls.at(-1)).toBe("delete #100");
	});

	it("delivers generated images once the reply is out", async () => {
		const { outbox, calls } = recordingOutbox();
		const view = createTurnView(outbox, { replyTo: 7, toolCallDetail: false });
		const image = { content: [{ type: "image", data: Buffer.from("png").toString("base64") }] };
		view.onEvent(toolEnd("generate_image", "a", image));
		view.onEvent(toolEnd("generate_image", "b", image));
		view.onEvent(toolEnd("read", "c", image));
		view.onEvent(answer("here"));
		await view.finish({ outcome: "completed" });
		expect(calls).toEqual(["send rich #100 ->7: here", "photos 2"]);
	});
});

describe("extractGeneratedImages", () => {
	const result = { content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] };

	it("delivers generate_image output", () => {
		expect(extractGeneratedImages("generate_image", result)).toEqual([Buffer.from("png")]);
	});

	it("skips images returned by read, which the agent may already be sending itself", () => {
		expect(extractGeneratedImages("read", result)).toEqual([]);
	});
});
