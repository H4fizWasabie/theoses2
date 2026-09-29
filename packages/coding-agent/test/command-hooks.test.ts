import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommandHook,
	type CommandHooksConfig,
	MAX_HOOK_OUTPUT_BYTES,
	mergeHooks,
	parseHooks,
	runCommandHook,
	runPostToolUse,
	runPreToolUse,
	runSessionHooks,
	runStopHooks,
	runUserPromptSubmit,
} from "../src/core/command-hooks.ts";

let dir: string;
const ctx = () => ({ cwd: dir, sessionId: "s1" });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "command-hooks-"));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function hook(command: string, extra: Partial<CommandHook> = {}): CommandHook {
	return { command, timeoutMs: 5000, failClosed: false, source: "user", ...extra };
}

const only = (event: keyof CommandHooksConfig, ...hooks: CommandHook[]): CommandHooksConfig => ({ [event]: hooks });

describe("parseHooks", () => {
	it("compiles matchers, clamps timeouts and reads failClosed", () => {
		const config = parseHooks(
			{ PreToolUse: [{ matcher: "^(bash|edit)$", command: "guard.sh", timeout: 9999, failClosed: true }] },
			"project",
		);
		const [h] = config.PreToolUse ?? [];
		expect(h.matcher?.test("bash")).toBe(true);
		expect(h.matcher?.test("read")).toBe(false);
		expect(h.timeoutMs).toBe(600_000);
		expect(h).toMatchObject({ failClosed: true, source: "project" });
	});

	it("skips and reports a bad entry without dropping the good ones", () => {
		const config = parseHooks(
			{
				PostToolUse: [{ command: "" }, { command: "ok.sh" }, { matcher: "(", command: "bad-regex.sh" }],
				Nonsense: [{ command: "x" }],
				Stop: "not-an-array",
			},
			"user",
		);
		expect(config.PostToolUse?.map((h) => h.command)).toEqual(["ok.sh"]);
		expect(config.Stop).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unknown hook event"));
	});

	it("treats a missing or non-object value as no hooks", () => {
		expect(parseHooks(undefined, "user")).toEqual({});
		expect(parseHooks([], "user")).toEqual({});
	});
});

describe("mergeHooks", () => {
	it("puts user hooks before project hooks and never lets a project replace them", () => {
		const user = parseHooks({ PreToolUse: [{ command: "user-guard.sh" }] }, "user");
		const project = parseHooks(
			{ PreToolUse: [{ command: "project.sh" }], Stop: [{ command: "stop.sh" }] },
			"project",
		);
		const merged = mergeHooks(user, project);
		expect(merged.PreToolUse?.map((h) => h.command)).toEqual(["user-guard.sh", "project.sh"]);
		expect(merged.Stop?.map((h) => h.command)).toEqual(["stop.sh"]);
	});
});

describe("runCommandHook", () => {
	it("gives the command its input as JSON on stdin and reads a JSON object back", async () => {
		const outcome = await runCommandHook(hook("cat"), { event: "PreToolUse", toolName: "bash" }, { cwd: dir });
		expect(outcome).toMatchObject({ kind: "ok", json: { event: "PreToolUse", toolName: "bash" } });
	});

	it("blocks on exit 2 with stderr as the reason", async () => {
		const outcome = await runCommandHook(hook("echo no rm here >&2; exit 2"), {}, { cwd: dir });
		expect(outcome).toEqual({ kind: "block", reason: "no rm here" });
	});

	it("reports any other non-zero exit as an error", async () => {
		const outcome = await runCommandHook(hook("echo oops >&2; exit 1"), {}, { cwd: dir });
		expect(outcome).toEqual({ kind: "error", message: "exit code 1: oops" });
	});

	it("kills a command that outlives its timeout", async () => {
		const outcome = await runCommandHook(hook("sleep 5", { timeoutMs: 200 }), {}, { cwd: dir });
		expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("timed out") });
	});

	it("stops a command whose output is too long", async () => {
		const outcome = await runCommandHook(
			hook(`head -c ${MAX_HOOK_OUTPUT_BYTES + 1000} /dev/zero | tr '\\0' a`),
			{},
			{ cwd: dir },
		);
		expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("output exceeds") });
	});

	it("handles a command that never reads its input", async () => {
		expect(await runCommandHook(hook("exit 0"), { big: "x".repeat(200_000) }, { cwd: dir })).toMatchObject({
			kind: "ok",
		});
	});

	it("keeps plain-text stdout without treating it as a decision", async () => {
		expect(await runCommandHook(hook("echo hello"), {}, { cwd: dir })).toEqual({
			kind: "ok",
			stdout: "hello\n",
			json: undefined,
		});
	});

	it("runs in the given directory and inherits the environment", async () => {
		process.env.HOOK_TEST_VALUE = "from-env";
		try {
			const outcome = await runCommandHook(
				hook('echo "{\\"cwd\\":\\"$(pwd)\\",\\"v\\":\\"$HOOK_TEST_VALUE\\"}"'),
				{},
				{ cwd: dir },
			);
			expect(outcome).toMatchObject({ kind: "ok", json: { v: "from-env" } });
			expect(outcome.kind === "ok" && String(outcome.json?.cwd).endsWith(dir.split("/").pop() as string)).toBe(true);
		} finally {
			delete process.env.HOOK_TEST_VALUE;
		}
	});

	it("never lets text in the input reach the shell", async () => {
		const marker = join(dir, "injected");
		await runCommandHook(
			hook("cat > /dev/null"),
			{ toolInput: { command: `$(touch ${marker}); touch ${marker}` } },
			{ cwd: dir },
		);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("runPreToolUse", () => {
	const call = () => ({
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "rm -rf x" } as Record<string, unknown>,
	});

	it("blocks on exit 2 and on a JSON block decision, and the first block wins", async () => {
		const later = join(dir, "later-ran");
		expect(
			await runPreToolUse(
				only("PreToolUse", hook("echo denied >&2; exit 2"), hook(`touch ${later}`)),
				ctx(),
				call(),
			),
		).toEqual({
			block: true,
			reason: "denied",
		});
		expect(existsSync(later)).toBe(false);
		expect(
			await runPreToolUse(only("PreToolUse", hook(`echo '{"decision":"block","reason":"policy"}'`)), ctx(), call()),
		).toEqual({ block: true, reason: "policy" });
	});

	it("replaces the call's input in place with updatedInput", async () => {
		const c = call();
		const result = await runPreToolUse(
			only("PreToolUse", hook(`echo '{"updatedInput":{"command":"ls"}}'`)),
			ctx(),
			c,
		);
		expect(result).toBeUndefined();
		expect(c.input).toEqual({ command: "ls" });
	});

	it("only runs hooks whose matcher fits the tool", async () => {
		const marker = join(dir, "ran");
		const config = only("PreToolUse", hook(`touch ${marker}; exit 2`, { matcher: /^edit$/ }));
		expect(await runPreToolUse(config, ctx(), call())).toBeUndefined();
		expect(existsSync(marker)).toBe(false);
	});

	it("fails open on a hook error, and closed when the hook says so", async () => {
		expect(await runPreToolUse(only("PreToolUse", hook("exit 1")), ctx(), call())).toBeUndefined();
		expect(
			await runPreToolUse(only("PreToolUse", hook("exit 1", { failClosed: true })), ctx(), call()),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("fail closed"),
		});
	});
});

describe("runPostToolUse", () => {
	const call = {
		toolName: "edit",
		toolCallId: "c1",
		input: { path: "a.ts" },
		content: [{ type: "text" as const, text: "edited" }],
		isError: false,
	};

	it("returns the context hooks want the model to see, including stderr from exit 2", async () => {
		const config = only(
			"PostToolUse",
			hook(`echo '{"additionalContext":"formatted a.ts"}'`),
			hook("echo lint failed >&2; exit 2"),
		);
		expect(await runPostToolUse(config, ctx(), call)).toEqual(["formatted a.ts", "lint failed"]);
	});

	it("hands the hook the tool result and whether it failed", async () => {
		const file = join(dir, "seen.json");
		await runPostToolUse(only("PostToolUse", hook(`cat > ${file}`)), ctx(), { ...call, isError: true });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			event: "PostToolUse",
			toolResult: "edited",
			isError: true,
			sessionId: "s1",
		});
	});

	it("skips a hook that errors", async () => {
		expect(await runPostToolUse(only("PostToolUse", hook("exit 3")), ctx(), call)).toEqual([]);
	});
});

describe("runUserPromptSubmit", () => {
	it("passes the prompt through when no hook has anything to say", async () => {
		expect(await runUserPromptSubmit(only("UserPromptSubmit", hook("exit 0")), ctx(), "hi")).toEqual({
			action: "continue",
		});
	});

	it("appends hook context after the prompt", async () => {
		const result = await runUserPromptSubmit(
			only("UserPromptSubmit", hook(`echo '{"additionalContext":"today is Tuesday"}'`)),
			ctx(),
			"hi",
		);
		expect(result).toEqual({ action: "transform", text: "hi\n\n[Context from hooks]\ntoday is Tuesday" });
	});

	it("swallows the prompt when a hook blocks it", async () => {
		expect(
			await runUserPromptSubmit(only("UserPromptSubmit", hook("echo not now >&2; exit 2")), ctx(), "hi"),
		).toEqual({
			action: "handled",
			reason: "not now",
		});
	});
});

describe("runSessionHooks and runStopHooks", () => {
	it("runs session hooks with the reason and ignores their output", async () => {
		const file = join(dir, "session.json");
		await runSessionHooks(only("SessionStart", hook(`cat > ${file}`)), "SessionStart", ctx(), "resume");
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ event: "SessionStart", reason: "resume" });
	});

	it("returns a Stop hook's block reason and tells it whether it already held the run open", async () => {
		const file = join(dir, "stop.json");
		const config = only("Stop", hook(`cat > ${file}; echo run the tests first >&2; exit 2`));
		expect(await runStopHooks(config, ctx(), { stopHookActive: true, lastAssistantText: "done" })).toBe(
			"run the tests first",
		);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			event: "Stop",
			stopHookActive: true,
			lastAssistantText: "done",
		});
	});

	it("lets the run end when no Stop hook blocks", async () => {
		expect(
			await runStopHooks(only("Stop", hook("exit 0")), ctx(), { stopHookActive: false, lastAssistantText: "" }),
		).toBeUndefined();
	});
});
