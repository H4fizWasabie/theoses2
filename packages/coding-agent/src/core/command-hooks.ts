/**
 * Command hooks: shell commands the owner configures under `hooks` in settings.json, run at fixed points of an
 * agent run. They can block or rewrite a tool call, add context, refuse to let a run end, or just react.
 *
 * Protocol: the command gets one JSON object on stdin (never argv or an interpolated string, so text the model
 * controls cannot inject shell). Exit 0 continues; a stdout that parses as a JSON object may carry a decision.
 * Exit 2 blocks, with stderr as the reason. Any other exit, a timeout, or over-long output is a hook error: it is
 * logged and the action continues, unless the hook sets `failClosed`.
 *
 * Config comes from the user settings and, when the project is trusted, the project settings. The two lists are
 * concatenated (see `mergeHooks`): settings merge would replace an array, and a repo must not be able to replace
 * the owner's guard hooks.
 */
import { spawn } from "node:child_process";
import type { ImageContent, TextContent } from "theoses-ai";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_TIMEOUT_SECONDS = 600;
export const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
/** Tool output handed to a PostToolUse hook is cut here so a huge result does not flood stdin. */
const MAX_TOOL_RESULT_CHARS = 20_000;
/** Custom message a blocking Stop hook feeds back, and how many times one run may be held open that way. */
export const STOP_HOOK_CUSTOM_TYPE = "stop-hook";
export const MAX_STOP_HOOK_PUSHES = 2;

export interface CommandHook {
	command: string;
	/** Tool-name filter for PreToolUse and PostToolUse; absent matches every tool. */
	matcher?: RegExp;
	timeoutMs: number;
	failClosed: boolean;
	source: "user" | "project";
}

export type CommandHooksConfig = Partial<Record<HookEvent, CommandHook[]>>;

const reported = new Set<string>();
function report(message: string): void {
	if (reported.has(message)) return;
	reported.add(message);
	console.error(`[hooks] ${message}`);
}

/** Validates one settings `hooks` value. A bad entry is reported once and skipped; the rest still load. */
export function parseHooks(raw: unknown, source: CommandHook["source"]): CommandHooksConfig {
	const config: CommandHooksConfig = {};
	if (raw === undefined || raw === null) return config;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		report(`${source} settings: "hooks" must be an object keyed by event name`);
		return config;
	}
	for (const [name, entries] of Object.entries(raw)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(name)) {
			report(`${source} settings: unknown hook event "${name}" (known: ${HOOK_EVENTS.join(", ")})`);
			continue;
		}
		if (!Array.isArray(entries)) {
			report(`${source} settings: hooks.${name} must be an array`);
			continue;
		}
		const parsed: CommandHook[] = [];
		entries.forEach((entry, index) => {
			const where = `${source} settings: hooks.${name}[${index}]`;
			const value = entry as Record<string, unknown> | null;
			if (
				typeof value !== "object" ||
				value === null ||
				typeof value.command !== "string" ||
				!value.command.trim()
			) {
				report(`${where} needs a non-empty "command"`);
				return;
			}
			let matcher: RegExp | undefined;
			if (value.matcher !== undefined) {
				try {
					matcher = new RegExp(String(value.matcher));
				} catch {
					report(`${where} has an invalid matcher regex: ${String(value.matcher)}`);
					return;
				}
			}
			const seconds =
				typeof value.timeout === "number" && value.timeout > 0
					? Math.min(value.timeout, MAX_HOOK_TIMEOUT_SECONDS)
					: DEFAULT_HOOK_TIMEOUT_SECONDS;
			parsed.push({
				command: value.command,
				matcher,
				timeoutMs: seconds * 1000,
				failClosed: value.failClosed === true,
				source,
			});
		});
		if (parsed.length > 0) config[name as HookEvent] = parsed;
	}
	return config;
}

/** User hooks first, then project hooks: a project can add hooks but never remove or replace the user's. */
export function mergeHooks(user: CommandHooksConfig, project: CommandHooksConfig): CommandHooksConfig {
	const merged: CommandHooksConfig = {};
	for (const event of HOOK_EVENTS) {
		const list = [...(user[event] ?? []), ...(project[event] ?? [])];
		if (list.length > 0) merged[event] = list;
	}
	return merged;
}

export type HookOutcome =
	| { kind: "ok"; json?: Record<string, unknown>; stdout: string }
	| { kind: "block"; reason: string }
	| { kind: "error"; message: string };

export interface HookRunOptions {
	cwd: string;
	signal?: AbortSignal;
}

function killTree(pid: number | undefined, fallback: () => void): void {
	try {
		if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
		else fallback();
	} catch {
		fallback();
	}
}

/** Runs one hook command with `input` as JSON on stdin. Never throws. */
export function runCommandHook(
	hook: CommandHook,
	input: Record<string, unknown>,
	options: HookRunOptions,
): Promise<HookOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome: HookOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const child = spawn(hook.command, {
			shell: true,
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const stop = (message: string) => {
			killTree(child.pid, () => child.kill("SIGKILL"));
			finish({ kind: "error", message });
		};
		const timer = setTimeout(() => stop(`timed out after ${hook.timeoutMs / 1000}s`), hook.timeoutMs);
		const onAbort = () => stop("aborted");
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_HOOK_OUTPUT_BYTES) stop(`output exceeds ${MAX_HOOK_OUTPUT_BYTES} bytes`);
			else into.push(chunk);
		};
		child.stdout.on("data", collect(out));
		child.stderr.on("data", collect(err));
		child.stdin.on("error", () => {
			// The hook may exit without reading its input.
		});
		child.on("error", (error) => finish({ kind: "error", message: error.message }));
		child.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8").trim();
			if (code === 2) return finish({ kind: "block", reason: stderr || "Blocked by a hook" });
			if (code !== 0) {
				const first = stderr.split("\n")[0] ?? "";
				return finish({ kind: "error", message: `exit code ${code}${first ? `: ${first}` : ""}` });
			}
			finish({ kind: "ok", stdout, json: parseJsonObject(stdout) });
		});
		child.stdin.end(`${JSON.stringify(input)}\n`);
	});
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export interface HookRunContext {
	cwd: string;
	sessionId: string;
	signal?: AbortSignal;
}

function matching(config: CommandHooksConfig, event: HookEvent, toolName?: string): CommandHook[] {
	return (config[event] ?? []).filter(
		(hook) => !hook.matcher || (toolName !== undefined && hook.matcher.test(toolName)),
	);
}

function base(event: HookEvent, ctx: HookRunContext): Record<string, unknown> {
	return { event, sessionId: ctx.sessionId, cwd: ctx.cwd };
}

function logError(event: HookEvent, hook: CommandHook, message: string): void {
	console.error(`[hooks] ${event} hook \`${hook.command}\` (${hook.source}) failed: ${message}`);
}

/** The reason a hook decision blocks, if it does: exit 2 or `{"decision":"block","reason"}`. */
function blockReason(outcome: HookOutcome): string | undefined {
	if (outcome.kind === "block") return outcome.reason;
	if (outcome.kind === "ok" && outcome.json?.decision === "block") {
		return typeof outcome.json.reason === "string" && outcome.json.reason ? outcome.json.reason : "Blocked by a hook";
	}
	return undefined;
}

function additionalContext(outcome: HookOutcome): string | undefined {
	if (outcome.kind !== "ok") return undefined;
	const value = outcome.json?.additionalContext;
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * PreToolUse hooks, in order. The first block wins. `{"updatedInput": {...}}` replaces the call's input in place
 * (so later hooks, extensions and the tool itself see it). Returns the block result, or undefined to go ahead.
 */
export async function runPreToolUse(
	config: CommandHooksConfig,
	ctx: HookRunContext,
	call: { toolName: string; toolCallId: string; input: Record<string, unknown> },
): Promise<{ block: true; reason: string } | undefined> {
	for (const hook of matching(config, "PreToolUse", call.toolName)) {
		const outcome = await runCommandHook(
			hook,
			{ ...base("PreToolUse", ctx), toolName: call.toolName, toolCallId: call.toolCallId, toolInput: call.input },
			ctx,
		);
		if (outcome.kind === "error") {
			logError("PreToolUse", hook, outcome.message);
			if (hook.failClosed)
				return { block: true, reason: `A PreToolUse hook failed and is set to fail closed: ${outcome.message}` };
			continue;
		}
		const reason = blockReason(outcome);
		if (reason !== undefined) return { block: true, reason };
		const updated = outcome.kind === "ok" ? outcome.json?.updatedInput : undefined;
		if (typeof updated === "object" && updated !== null && !Array.isArray(updated)) {
			for (const key of Object.keys(call.input)) delete call.input[key];
			Object.assign(call.input, updated);
		}
	}
	return undefined;
}

function textOf(content: ReadonlyArray<TextContent | ImageContent>): string {
	const text = content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
	return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]` : text;
}

/** PostToolUse hooks, in order. Returns the extra context they want the model to see with this result. */
export async function runPostToolUse(
	config: CommandHooksConfig,
	ctx: HookRunContext,
	call: {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
		content: ReadonlyArray<TextContent | ImageContent>;
		isError: boolean;
	},
): Promise<string[]> {
	const extra: string[] = [];
	for (const hook of matching(config, "PostToolUse", call.toolName)) {
		const outcome = await runCommandHook(
			hook,
			{
				...base("PostToolUse", ctx),
				toolName: call.toolName,
				toolCallId: call.toolCallId,
				toolInput: call.input,
				toolResult: textOf(call.content),
				isError: call.isError,
			},
			ctx,
		);
		if (outcome.kind === "error") {
			logError("PostToolUse", hook, outcome.message);
			continue;
		}
		// Exit 2 has nothing to block after the fact: its stderr goes to the model as context.
		const context = outcome.kind === "block" ? outcome.reason : additionalContext(outcome);
		if (context) extra.push(context);
	}
	return extra;
}

export type PromptHookResult =
	| { action: "continue" }
	| { action: "transform"; text: string }
	| { action: "handled"; reason: string };

/** UserPromptSubmit hooks, in order: one can swallow the prompt, others add context after it. */
export async function runUserPromptSubmit(
	config: CommandHooksConfig,
	ctx: HookRunContext,
	prompt: string,
): Promise<PromptHookResult> {
	const contexts: string[] = [];
	for (const hook of matching(config, "UserPromptSubmit")) {
		const outcome = await runCommandHook(hook, { ...base("UserPromptSubmit", ctx), prompt }, ctx);
		if (outcome.kind === "error") {
			logError("UserPromptSubmit", hook, outcome.message);
			if (hook.failClosed)
				return {
					action: "handled",
					reason: `A UserPromptSubmit hook failed and is set to fail closed: ${outcome.message}`,
				};
			continue;
		}
		const reason = blockReason(outcome);
		if (reason !== undefined) return { action: "handled", reason };
		const context = additionalContext(outcome);
		if (context) contexts.push(context);
	}
	if (contexts.length === 0) return { action: "continue" };
	return { action: "transform", text: `${prompt}\n\n[Context from hooks]\n${contexts.join("\n\n")}` };
}

/** SessionStart and SessionEnd hooks: side effects only, so their outcomes are only logged. */
export async function runSessionHooks(
	config: CommandHooksConfig,
	event: "SessionStart" | "SessionEnd",
	ctx: HookRunContext,
	reason: string,
): Promise<void> {
	for (const hook of matching(config, event)) {
		const outcome = await runCommandHook(hook, { ...base(event, ctx), reason }, ctx);
		if (outcome.kind === "error") logError(event, hook, outcome.message);
	}
}

/**
 * Stop hooks, in order: the first to block returns its reason, which the caller feeds back to the model so the run
 * continues. `stopHookActive` tells a hook the run is already continuing because of one, so it can let go.
 */
export async function runStopHooks(
	config: CommandHooksConfig,
	ctx: HookRunContext,
	details: { stopHookActive: boolean; lastAssistantText: string },
): Promise<string | undefined> {
	for (const hook of matching(config, "Stop")) {
		const outcome = await runCommandHook(hook, { ...base("Stop", ctx), ...details }, ctx);
		if (outcome.kind === "error") {
			logError("Stop", hook, outcome.message);
			if (hook.failClosed) return `A Stop hook failed and is set to fail closed: ${outcome.message}`;
			continue;
		}
		const reason = blockReason(outcome);
		if (reason !== undefined) return reason;
	}
	return undefined;
}
