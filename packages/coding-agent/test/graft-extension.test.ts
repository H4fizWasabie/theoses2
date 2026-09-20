import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import graftExtension from "../../../.theoses/extensions/graft.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadExtension() {
	const handlers = new Map<string, Handler>();
	graftExtension({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
	return handlers;
}

describe("graft extension", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "graft-ext-test-"));
		cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd);
		// Stand-in for @nanonets/graft/dist/claude/hooks.js: echoes the event and prompt it was given on stdin.
		fs.writeFileSync(
			path.join(tempDir, "hooks.mjs"),
			`export async function main(event) {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	const input = JSON.parse(raw);
	const context = event === "prompt" ? "hint for: " + input.prompt : "intro";
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: context } }));
}
`,
		);
		process.env.THEOSES_GRAFT_HOOKS_JS = path.join(tempDir, "hooks.mjs");
	});

	afterEach(() => {
		delete process.env.THEOSES_GRAFT_HOOKS_JS;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("adds nothing when the session directory has no built graph", async () => {
		const handlers = loadExtension();
		const result = await handlers.get("before_agent_start")?.({ prompt: "hi" }, { cwd });
		expect(result).toBeUndefined();
	});

	it("injects the session intro once, then only per-prompt hints, as a hidden message", async () => {
		fs.mkdirSync(path.join(cwd, "graft"));
		const handlers = loadExtension();
		const first = (await handlers.get("before_agent_start")?.({ prompt: "one" }, { cwd })) as {
			message: { customType: string; content: string; display: boolean };
		};
		expect(first.message).toEqual({
			customType: "graft-context",
			content: "intro\n\nhint for: one",
			display: false,
		});
		const second = (await handlers.get("before_agent_start")?.({ prompt: "two" }, { cwd })) as {
			message: { content: string };
		};
		expect(second.message.content).toBe("hint for: two");
	});

	it("announces the graph again after a new session starts", async () => {
		fs.mkdirSync(path.join(cwd, "graft"));
		const handlers = loadExtension();
		await handlers.get("before_agent_start")?.({ prompt: "one" }, { cwd });
		handlers.get("session_start")?.({}, {});
		const result = (await handlers.get("before_agent_start")?.({ prompt: "two" }, { cwd })) as {
			message: { content: string };
		};
		expect(result.message.content).toBe("intro\n\nhint for: two");
	});

	it("fails open when graft is not installed", async () => {
		fs.mkdirSync(path.join(cwd, "graft"));
		process.env.THEOSES_GRAFT_HOOKS_JS = path.join(tempDir, "missing.mjs");
		const handlers = loadExtension();
		const result = await handlers.get("before_agent_start")?.({ prompt: "hi" }, { cwd });
		expect(result).toBeUndefined();
	});
});
