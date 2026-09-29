import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "theoses-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STOP_HOOK_PUSHES, STOP_HOOK_CUSTOM_TYPE } from "../../src/core/command-hooks.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

type Hooks = Record<string, Array<Record<string, unknown>>>;

describe("AgentSession command hooks", () => {
	const harnesses: Harness[] = [];
	const echoRuns: string[] = [];

	beforeEach(() => {
		echoRuns.length = 0;
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, params) => {
			const text = String((params as { text?: unknown }).text ?? "");
			echoRuns.push(text);
			return { content: [{ type: "text", text: `echo:${text}` }], details: {} };
		},
	};

	async function harness(hooks: Hooks, options: { persist?: boolean; tools?: AgentTool[] } = {}): Promise<Harness> {
		const created = await createHarness({
			tools: options.tools ?? [echoTool],
			persist: options.persist,
			settings: { hooks },
		});
		harnesses.push(created);
		return created;
	}

	const callEcho = (text = "hello") => fauxAssistantMessage(fauxToolCall("echo", { text }), { stopReason: "toolUse" });

	function toolResultText(h: Harness): string {
		const result = h.session.messages.find((m) => m.role === "toolResult");
		if (!result || result.role !== "toolResult") throw new Error("no tool result");
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	const customMessages = (h: Harness, customType: string) =>
		h.session.messages.filter((m) => m.role === "custom" && m.customType === customType);

	describe("PreToolUse", () => {
		it("blocks a tool call, and the model sees why", async () => {
			const h = await harness({
				PreToolUse: [{ matcher: "^echo$", command: "echo 'not allowed here' >&2; exit 2" }],
			});
			h.setResponses([callEcho(), fauxAssistantMessage("done")]);

			await h.session.prompt("go");

			expect(echoRuns).toEqual([]);
			const result = h.session.messages.find((m) => m.role === "toolResult");
			expect(result?.role === "toolResult" && result.isError).toBe(true);
			expect(toolResultText(h)).toContain("not allowed here");
		});

		it("rewrites a tool call's input", async () => {
			const h = await harness({ PreToolUse: [{ command: `echo '{"updatedInput":{"text":"rewritten"}}'` }] });
			h.setResponses([callEcho("original"), fauxAssistantMessage("done")]);

			await h.session.prompt("go");

			expect(echoRuns).toEqual(["rewritten"]);
		});

		it("checkpoints the file a rewritten call really changes, not the one the model named", async () => {
			const write: AgentTool = {
				name: "write",
				label: "Write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				execute: async (_id, params) => {
					const { path, content } = params as { path: string; content: string };
					writeFileSync(join(directory, path), content);
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			let directory = "";
			const h = await harness(
				{
					PreToolUse: [
						{ matcher: "^write$", command: `echo '{"updatedInput":{"path":"b.txt","content":"new"}}'` },
					],
				},
				{ persist: true, tools: [write] },
			);
			directory = h.tempDir;
			writeFileSync(join(directory, "b.txt"), "original b");
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await h.session.prompt("go");

			expect(existsSync(join(directory, "a.txt"))).toBe(false);
			const userId = h.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")
				?.id as string;
			expect(h.session.previewFileRewind(userId).restore.map((r) => r.path)).toEqual([join(directory, "b.txt")]);
			h.session.rewindFiles(userId);
			expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("original b");
		});

		it("lets the call through when a hook errors, unless the hook fails closed", async () => {
			const open = await harness({ PreToolUse: [{ command: "exit 1" }] });
			open.setResponses([callEcho("open"), fauxAssistantMessage("done")]);
			await open.session.prompt("go");
			expect(echoRuns).toEqual(["open"]);

			const closed = await harness({ PreToolUse: [{ command: "exit 1", failClosed: true }] });
			closed.setResponses([callEcho("closed"), fauxAssistantMessage("done")]);
			await closed.session.prompt("go");
			expect(echoRuns).toEqual(["open"]);
			expect(toolResultText(closed)).toContain("fail closed");
		});
	});

	describe("PostToolUse", () => {
		it("adds the hook's context to the tool result the model reads", async () => {
			const h = await harness({
				PostToolUse: [{ matcher: "^echo$", command: `echo '{"additionalContext":"lint ok"}'` }],
			});
			h.setResponses([callEcho("hi"), fauxAssistantMessage("done")]);

			await h.session.prompt("go");

			expect(toolResultText(h)).toBe("echo:hi[Hook] lint ok");
		});
	});

	describe("UserPromptSubmit", () => {
		it("appends hook context to the prompt", async () => {
			const h = await harness({
				UserPromptSubmit: [{ command: `echo '{"additionalContext":"today is Tuesday"}'` }],
			});
			h.setResponses([fauxAssistantMessage("hi")]);

			await h.session.prompt("what day is it");

			expect(getUserTexts(h)[0]).toContain("what day is it");
			expect(getUserTexts(h)[0]).toContain("[Context from hooks]\ntoday is Tuesday");
		});

		it("swallows a blocked prompt, tells the user why, and never calls the model", async () => {
			const h = await harness({ UserPromptSubmit: [{ command: "echo 'not now' >&2; exit 2" }] });
			h.setResponses([fauxAssistantMessage("should never be sent")]);

			await h.session.prompt("hello");

			expect(h.getPendingResponseCount()).toBe(1);
			expect(getAssistantTexts(h)).toEqual([]);
			expect(JSON.stringify(customMessages(h, "hook-blocked"))).toContain("A hook blocked this prompt: not now");
		});
	});

	describe("Stop", () => {
		it("holds the run open once with the hook's reason, then lets it end", async () => {
			const h = await harness({
				Stop: [
					{
						command:
							"if [ -f stop-seen ]; then exit 0; fi; touch stop-seen; echo 'run the checks first' >&2; exit 2",
					},
				],
			});
			h.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

			await h.session.prompt("do it");

			expect(getAssistantTexts(h)).toEqual(["first answer", "second answer"]);
			expect(JSON.stringify(customMessages(h, STOP_HOOK_CUSTOM_TYPE))).toContain("run the checks first");
		});

		it("cannot hold a run open forever", async () => {
			const h = await harness({ Stop: [{ command: "echo 'again' >&2; exit 2" }] });
			h.setResponses(Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`answer ${i + 1}`)));

			await h.session.prompt("do it");

			expect(getAssistantTexts(h)).toHaveLength(MAX_STOP_HOOK_PUSHES + 1);
			expect(customMessages(h, STOP_HOOK_CUSTOM_TYPE)).toHaveLength(MAX_STOP_HOOK_PUSHES);
		});

		it("tells the hook when it is already holding the run open", async () => {
			const h = await harness({
				Stop: [{ command: "cat >> stop-inputs.jsonl; echo again >&2; exit 2" }],
			});
			h.setResponses(Array.from({ length: 4 }, (_, i) => fauxAssistantMessage(`answer ${i + 1}`)));

			await h.session.prompt("do it");

			const lines = readFileSync(join(h.tempDir, "stop-inputs.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(lines.map((l) => l.stopHookActive)).toEqual([false, true]);
			expect(lines[0]).toMatchObject({ event: "Stop", lastAssistantText: "answer 1" });
		});
	});

	describe("SessionStart and SessionEnd", () => {
		it("runs the owner's session hooks with the reason", async () => {
			const h = await harness({
				SessionStart: [{ command: "cat > session-start.json" }],
				SessionEnd: [{ command: "cat > session-end.json" }],
			});

			await h.session.runSessionHooks("SessionStart", "startup");
			await h.session.runSessionHooks("SessionEnd", "quit");

			expect(JSON.parse(readFileSync(join(h.tempDir, "session-start.json"), "utf8"))).toMatchObject({
				event: "SessionStart",
				reason: "startup",
			});
			expect(JSON.parse(readFileSync(join(h.tempDir, "session-end.json"), "utf8"))).toMatchObject({
				event: "SessionEnd",
				reason: "quit",
			});
		});
	});
});
