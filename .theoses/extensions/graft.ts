import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "theoses-coding-agent";

/**
 * Wires Graft (https://github.com/trailhq/Graft) into a Theoses session the way `graft init` wires it into
 * Claude Code. Graft's Claude hooks are stdin-JSON -> stdout-JSON commands (`session-start`, `prompt`) whose
 * answer is `hookSpecificOutput.additionalContext`; this extension runs the same commands and hands that text to
 * the model as a hidden custom message before each agent turn.
 *
 * It does nothing unless the session's cwd holds a built graph (`graft/`), so sessions in other directories, such
 * as the chat bots, are untouched. It fails open on every path: no graft install, a timeout or bad output all mean
 * "add nothing". The hint goes in a message, not the system prompt, so it never invalidates the prompt cache.
 *
 * `THEOSES_GRAFT_HOOKS_JS` overrides the resolved `@nanonets/graft/dist/claude/hooks.js` (used by tests).
 */

const HOOK_TIMEOUT_MS = 8000;

let hooksJsPromise: Promise<string | undefined> | undefined;

function run(command: string, args: string[], input?: string, timeoutMs = HOOK_TIMEOUT_MS): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: process.env });
			let out = "";
			const timer = setTimeout(() => child.kill(), timeoutMs);
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? out : undefined);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(input ?? "");
		} catch {
			resolve(undefined);
		}
	});
}

function resolveHooksJs(): Promise<string | undefined> {
	const override = process.env.THEOSES_GRAFT_HOOKS_JS;
	if (override) return Promise.resolve(existsSync(override) ? override : undefined);
	hooksJsPromise ??= (async () => {
		const root = (await run("npm", ["root", "-g"], undefined, 5000))?.trim();
		if (!root) return undefined;
		const file = join(root, "@nanonets", "graft", "dist", "claude", "hooks.js");
		return existsSync(file) ? file : undefined;
	})();
	return hooksJsPromise;
}

/** Runs one Graft hook event and returns its `additionalContext`, or undefined when there is nothing to add. */
async function graftContext(event: "session-start" | "prompt", cwd: string, sessionId: string, prompt?: string) {
	const hooksJs = await resolveHooksJs();
	if (!hooksJs) return undefined;
	const payload = JSON.stringify({
		cwd,
		session_id: sessionId,
		hook_event_name: event === "prompt" ? "UserPromptSubmit" : "SessionStart",
		...(prompt === undefined ? {} : { prompt }),
	});
	const script = `import(${JSON.stringify(pathToFileURL(hooksJs).href)}).then((m) => m.main(${JSON.stringify(event)}))`;
	const stdout = await run(process.execPath, ["--input-type=module", "-e", script], payload);
	if (!stdout) return undefined;
	try {
		const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
		const context = parsed.hookSpecificOutput?.additionalContext;
		return typeof context === "string" && context.trim() ? context : undefined;
	} catch {
		return undefined;
	}
}

export default function (theoses: ExtensionAPI) {
	let sessionAnnounced = false;

	theoses.on("session_start", () => {
		sessionAnnounced = false;
	});

	theoses.on("before_agent_start", async (event, ctx) => {
		if (!existsSync(join(ctx.cwd, "graft"))) return;
		const sessionId = `theoses-${process.pid}`;
		const parts: string[] = [];

		if (!sessionAnnounced) {
			sessionAnnounced = true;
			const intro = await graftContext("session-start", ctx.cwd, sessionId);
			if (intro) parts.push(intro);
		}
		const hint = await graftContext("prompt", ctx.cwd, sessionId, event.prompt);
		if (hint) parts.push(hint);
		if (parts.length === 0) return;

		return { message: { customType: "graft-context", content: parts.join("\n\n"), display: false } };
	});
}
