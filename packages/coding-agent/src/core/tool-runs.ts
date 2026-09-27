/**
 * What a run's tool calls did, read back from its messages: which calls changed files, which commands
 * passed, and what they printed. Shared by the stop-time checks (claim-check.ts, task-plan.ts) so they
 * agree on what counts as a file change and what counts as a verification command.
 */
import type { AgentMessage } from "theoses-agent-core";
import type { ToolCall, ToolResultMessage } from "theoses-ai";

export const FILE_TOOLS = new Set(["edit", "write"]);
export const COMMAND_TOOLS = new Set(["bash", "powershell"]);

export interface ToolRun {
	id: string;
	name: string;
	/** `path` for edit/write, `command` for bash/powershell. */
	path: string | undefined;
	command: string | undefined;
	isError: boolean;
	output: string;
}

export function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

export function firstLine(text: string, max = 200): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Tool results in execution order, each joined to its call's name and `path`/`command` argument. */
export function toolRuns(messages: AgentMessage[]): ToolRun[] {
	const calls = new Map<string, ToolCall>();
	const runs: ToolRun[] = [];
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, c);
		} else if (m.role === "toolResult") {
			const result = m as ToolResultMessage;
			const args = calls.get(result.toolCallId)?.arguments ?? {};
			runs.push({
				id: result.toolCallId,
				name: result.toolName,
				path: typeof args.path === "string" ? args.path : undefined,
				command: typeof args.command === "string" ? args.command : undefined,
				isError: result.isError === true,
				output: textOf(result.content),
			});
		}
	}
	return runs;
}

/** Messages since the last user message: the current run, including harness pushes and their replies. */
export function currentRunMessages(messages: AgentMessage[]): AgentMessage[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return messages.slice(i);
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Shell command classification. Heuristic by design: a missed file change only weakens the checks,
// it never makes them wrong. Commands whose effect cannot be parsed count as unknown changes.
// ---------------------------------------------------------------------------

/** Commands that only look at things. A passing one proves nothing about a change. */
const READ_ONLY_COMMANDS = new Set([
	"cd",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"fd",
	"wc",
	"echo",
	"printf",
	"pwd",
	"stat",
	"file",
	"which",
	"type",
	"test",
	"[",
	"[[",
	"true",
	"false",
	"diff",
	"tree",
	"du",
	"df",
	"sort",
	"uniq",
	"cut",
	"tr",
	"jq",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"date",
	"whoami",
	"env",
	"ps",
	"graft",
	"sleep",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "blame", "ls-files", "grep"]);
const MUTATING_GIT = new Set(["apply", "checkout", "restore", "reset", "stash", "mv", "rm", "am", "cherry-pick"]);
/** A script body that writes files (python/node heredocs and -c/-e one-liners). */
const SCRIPT_WRITE =
	/open\([^)]*['"][wax]b?\+?['"]|\.write_(text|bytes)\(|writeFileSync|appendFileSync|fs\.(promises\.)?(write|append|rm|unlink|rename)|shutil\.(copy|move|rmtree)|os\.(remove|unlink|rename|replace)/;

function isScratchPath(path: string, command: string): boolean {
	if (path === "/tmp" || path.startsWith("/tmp/") || path.startsWith("/dev/")) return true;
	// ponytail: any variable target counts as scratch when the command calls mktemp; tracking which variable holds the mktemp path needs a shell parser.
	return path.startsWith("$") && command.includes("mktemp");
}

/** Splits into lines, dropping heredoc bodies (data, not commands). */
function commandLines(command: string): { lines: string[]; heredocBodies: string } {
	const lines: string[] = [];
	let bodies = "";
	let terminator: string | undefined;
	for (const line of command.split("\n")) {
		if (terminator !== undefined) {
			if (line.trim() === terminator) terminator = undefined;
			else bodies += `${line}\n`;
			continue;
		}
		lines.push(line);
		const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
		if (heredoc) terminator = heredoc[1];
	}
	return { lines, heredocBodies: bodies };
}

/** Quote-aware split of one line into simple commands on ; && || | and &. */
function splitSegments(line: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		// `>&`/`&>` are redirects, not separators.
		if (ch === ";" || ch === "|" || (ch === "&" && line[i - 1] !== ">" && line[i + 1] !== ">")) {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments.map((s) => s.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
	return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}

/** Drops quoted strings so a `>` inside a script argument is not read as a redirect. */
function unquoted(segment: string): string {
	return segment.replace(/"[^"]*"|'[^']*'/g, " ");
}

interface SegmentEffect {
	readOnly: boolean;
	paths: string[];
	unknownChange: boolean;
}

function segmentEffect(segment: string, command: string): SegmentEffect {
	const paths: string[] = [];
	let unknownChange = false;
	const redirect = /(?:^|[^<>0-9&])(?:[0-9]|&)?>>?\s*([^\s;&|<>]+)/g;
	for (const match of unquoted(segment).matchAll(redirect)) {
		if (!match[1].startsWith("&")) paths.push(match[1]);
	}

	let tokens = tokenize(segment);
	while (tokens.length > 0 && (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) {
		tokens = tokens.slice(1);
	}
	const name = (tokens[0] ?? "").split("/").pop() ?? "";
	const args = tokens.slice(1).filter((t) => !/^[0-9]*>|^&>|^</.test(t));
	const operands = args.filter((t) => !t.startsWith("-"));

	if ((name === "sed" || name === "perl") && args.some((t) => /^-[a-z]*i/.test(t))) {
		const scriptFlagged = args.some((t) => t === "-e");
		const files: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-e") {
				i++;
				continue;
			}
			if (!args[i].startsWith("-")) files.push(args[i]);
		}
		paths.push(...(scriptFlagged ? files : files.slice(1)));
		if (files.length === 0) unknownChange = true;
	} else if (name === "tee") {
		paths.push(...operands);
	} else if (name === "cp" || name === "install") {
		if (operands.length > 0) paths.push(operands[operands.length - 1]);
	} else if (name === "mv" || name === "rm" || name === "touch" || name === "truncate") {
		paths.push(...operands);
	} else if (name === "patch") {
		unknownChange = true;
	} else if (name === "git" && MUTATING_GIT.has(operands[0] ?? "")) {
		unknownChange = true;
	} else if (/^(python[0-9.]*|node|ruby|perl|deno|bun)$/.test(name) && SCRIPT_WRITE.test(command)) {
		unknownChange = true;
	}

	const realPaths = paths.filter((p) => !isScratchPath(p, command));
	const readOnly =
		realPaths.length === 0 &&
		!unknownChange &&
		(READ_ONLY_COMMANDS.has(name) ||
			(name === "sed" && args.includes("-n")) ||
			(name === "git" && READ_ONLY_GIT.has(operands[0] ?? "")));
	return { readOnly, paths: realPaths, unknownChange };
}

export interface CommandEffect {
	/** Every simple command in it only reads (grep, cat, ls, git status...). */
	readOnly: boolean;
	/** Changes files outside scratch space. */
	changesFiles: boolean;
	/** Target paths that could be read off the command (relative ones are relative to its cwd). */
	paths: string[];
	/** Changes files in a way whose targets cannot be read off the command (a script, patch, git apply). */
	unknownChange: boolean;
}

export function commandEffect(command: string): CommandEffect {
	const { lines, heredocBodies } = commandLines(command);
	const effects = lines.flatMap(splitSegments).map((s) => segmentEffect(s, `${command}\n${heredocBodies}`));
	const paths = [...new Set(effects.flatMap((e) => e.paths))];
	return {
		readOnly: effects.every((e) => e.readOnly),
		changesFiles: paths.length > 0 || effects.some((e) => e.unknownChange),
		paths,
		unknownChange: effects.some((e) => e.unknownChange),
	};
}

/** True when this tool run changed (or tried to change) files. A failed edit/write changed nothing. */
export function runChangesFiles(run: ToolRun): boolean {
	if (FILE_TOOLS.has(run.name)) return !run.isError;
	if (COMMAND_TOOLS.has(run.name) && run.command) return commandEffect(run.command).changesFiles;
	return false;
}

/** A command that ran something beyond reading, without itself changing files: the only kind that can prove a change works. */
export function isCheckCommand(run: ToolRun): boolean {
	if (!COMMAND_TOOLS.has(run.name) || run.command === undefined) return false;
	const effect = commandEffect(run.command);
	return !effect.readOnly && !effect.changesFiles;
}

/**
 * Whether a passing check command ran after this run's last file change. `lastCheck` is the latest
 * check command after that change, passing or not; without one there is nothing to show.
 */
export function checkAfterLastChange(runs: ToolRun[]): { changed: boolean; lastCheck?: ToolRun; lastChange?: ToolRun } {
	let lastChangeIndex = -1;
	runs.forEach((run, i) => {
		if (runChangesFiles(run)) lastChangeIndex = i;
	});
	const lastCheck = runs
		.slice(lastChangeIndex + 1)
		.filter(isCheckCommand)
		.pop();
	return { changed: lastChangeIndex >= 0, lastCheck, lastChange: runs[lastChangeIndex] };
}
