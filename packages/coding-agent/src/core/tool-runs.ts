/**
 * What a run's tool calls did, read back from its messages: which calls changed files, which commands
 * passed, and what they printed. Shared by the stop-time checks (claim-check.ts, task-plan.ts) so they
 * agree on what counts as a file change and what counts as a verification command.
 */
import { isAbsolute, join, relative, resolve } from "node:path";
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
	"set",
	"export",
	"unset",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "blame", "ls-files", "grep"]);
const MUTATING_GIT = new Set(["apply", "checkout", "restore", "reset", "stash", "mv", "rm", "am", "cherry-pick"]);
/** A script body that writes files (python/node heredocs and -c/-e one-liners). */
const SCRIPT_WRITE =
	/open\([^)]*['"][wax]b?\+?['"]|\.write_(text|bytes)\(|\b(writeFile|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync|truncateSync)\b|writeFileSync|appendFileSync|fs\.(promises\.)?(write|append|rm|unlink|rename)|shutil\.(copy|move|rmtree)|os\.(remove|unlink|rename|replace)/;

function within(path: string, dir: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Lexical isolation, not a filesystem sandbox: variables, traversal and source locations are not artifacts. */
function isScratchPath(
	path: string,
	cwd: string,
	protectedPaths: readonly string[],
	sourceDirs: readonly string[],
): boolean {
	if (path.split(/[\\/]/).includes("..") || /[$`*?]/.test(path)) return false;
	if (path === "/dev/null") return true;
	if (!path.startsWith("/tmp/") || within(path, cwd) || sourceDirs.some((dir) => within(path, dir))) return false;
	return !protectedPaths.some((source) => resolve(cwd, source) === resolve(path));
}

/** Only literal, non-destructive artifact writes can clear SCRIPT_WRITE; every unmatched writer stays unknown. */
function writesOnlyArtifacts(
	command: string,
	cwd: string,
	protectedPaths: readonly string[],
	sourceDirs: readonly string[],
): boolean {
	const literalWriter =
		/(?:writeFile(?:Sync)?|appendFile(?:Sync)?|fs\.(?:promises\.)?(?:writeFile|appendFile))\(\s*(["'])([^"'\\\n]*)\1\s*,/g;
	const pythonOpen = /open\(\s*(["'])([^"'\\\n]*)\1\s*,\s*(["'])[wax]b?\+?\3\s*\)/g;
	const pythonPath = /(?:pathlib\.)?Path\(\s*(["'])([^"'\\\n]*)\1\s*\)\.write_(?:text|bytes)\(/g;
	const replace = (match: string, _quote: string, path: string): string =>
		isScratchPath(path, cwd, protectedPaths, sourceDirs) ? "isolatedArtifact(" : match;
	// Importing a writer is not itself a write. Keep aliased bindings conservative; their later calls cannot be traced here.
	const namedImport = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])(?:node:)?fs(?:\/promises)?\2/g;
	const destructure = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(["'])(?:node:)?fs(?:\/promises)?\2\s*\)/g;
	const source = command
		.replace(namedImport, (match, names: string) => (/\bas\b/.test(names) ? match : ""))
		.replace(destructure, (match, names: string) => (/[:=]/.test(names) ? match : ""));
	const remaining = source.replace(literalWriter, replace).replace(pythonOpen, replace).replace(pythonPath, replace);
	return !SCRIPT_WRITE.test(remaining);
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

function segmentEffect(
	segment: string,
	command: string,
	cwd: string,
	protectedPaths: readonly string[],
	sourceDirs: readonly string[],
): SegmentEffect {
	const paths: string[] = [];
	let unknownChange = false;
	// Keep offsets while masking script strings; read a redirect's quoted target from the original text.
	const masked = segment.replace(/"[^"]*"|'[^']*'/g, (quoted) => " ".repeat(quoted.length));
	const redirect = /(?:^|[^<>0-9&])(?:[0-9]|&)?>>?/g;
	for (const match of masked.matchAll(redirect)) {
		const target = segment
			.slice(match.index + match[0].length)
			.trimStart()
			.match(/^(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/);
		const path = target?.[1] ?? target?.[2] ?? target?.[3];
		if (path) paths.push(path);
	}

	let tokens = tokenize(segment);
	while (tokens.length > 0 && (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) {
		tokens = tokens.slice(1);
	}
	const name =
		(tokens[0] ?? "")
			.split(/[\\/]/)
			.pop()
			?.replace(/\.exe$/i, "") ?? "";
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
	} else if (
		(["biome", "eslint", "ruff", "prettier"].includes(name) &&
			args.some((arg) => ["--write", "--fix", "--fix-only"].includes(arg))) ||
		(name === "black" && !args.includes("--check") && !args.includes("--diff")) ||
		(name === "gofmt" && args.includes("-w"))
	) {
		unknownChange = true;
	} else if (
		[
			"set-content",
			"add-content",
			"out-file",
			"new-item",
			"remove-item",
			"move-item",
			"copy-item",
			"set-item",
		].includes(name.toLowerCase())
	) {
		// PowerShell writers without a parsed, provably isolated target cannot serve as verification.
		unknownChange = true;
	} else if (name === "patch") {
		unknownChange = true;
	} else if (name === "git" && MUTATING_GIT.has(operands[0] ?? "")) {
		unknownChange = true;
	} else if (/^(python[0-9.]*|node|ruby|perl|deno|bun)$/.test(name) && SCRIPT_WRITE.test(command)) {
		unknownChange = !writesOnlyArtifacts(command, cwd, protectedPaths, sourceDirs);
	}

	const realPaths = paths.filter((p) => !isScratchPath(p, cwd, protectedPaths, sourceDirs));
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
	/** Target paths that could be read off the command, after any `cd` (relative ones are relative to its cwd). */
	paths: string[];
	/** Directories the command `cd`s into before changing files, so an untraced change still has a location. */
	dirs: string[];
	/** Changes files in a way whose targets cannot be read off the command (a script, patch, git apply). */
	unknownChange: boolean;
}

export function commandEffect(
	command: string,
	cwd = process.cwd(),
	protectedPaths: readonly string[] = [],
): CommandEffect {
	const { lines, heredocBodies } = commandLines(command);
	const context = `${command}\n${heredocBodies}`;
	const paths = new Set<string>();
	const dirs = new Set<string>();
	let readOnly = true;
	let unknownChange = false;
	let dir: string | undefined;
	const segments = lines.flatMap(splitSegments);
	const sourceDirs: string[] = [];
	let selected = cwd;
	let unknownDirectory = false;
	for (const segment of segments) {
		const [name, target] = tokenize(segment);
		if (name !== "cd" || !target || target === "-") continue;
		if (/[$`~]/.test(target)) unknownDirectory = true;
		else {
			selected = resolve(selected, target);
			sourceDirs.push(selected);
		}
	}
	for (const segment of segments) {
		const effect = segmentEffect(segment, context, cwd, protectedPaths, sourceDirs);
		const [name, target] = tokenize(segment);
		if (name === "cd" && target && target !== "-") dir = inDir(dir, target);
		const changed = effect.paths
			.map((p) => inDir(dir, p))
			.filter((p) => !isScratchPath(p, cwd, protectedPaths, sourceDirs));
		for (const p of changed) paths.add(p);
		if (dir && !isScratchPath(dir, cwd, protectedPaths, sourceDirs) && (changed.length > 0 || effect.unknownChange))
			dirs.add(dir);
		readOnly &&= effect.readOnly;
		unknownChange ||= effect.unknownChange;
	}
	unknownChange ||= unknownDirectory && !readOnly;
	return {
		readOnly,
		changesFiles: paths.size > 0 || unknownChange,
		paths: [...paths],
		dirs: [...dirs],
		unknownChange,
	};
}

/** `path` as seen after `cd dir`; absolute, home and variable paths stay as written. */
function inDir(dir: string | undefined, path: string): string {
	return dir && !isAbsolute(path) && !path.startsWith("~") && !path.startsWith("$") ? join(dir, path) : path;
}

export interface FileChanges {
	/** Targets of the change: an edit/write path, or what could be read off a shell command. */
	paths: string[];
	/** Directories a shell command changed files in, when its targets could not be read off. */
	dirs: string[];
	/** The shell command itself, when it changes files in a way whose targets cannot be read off. */
	untraced?: string;
}

/** The files a tool call is about to change, or undefined when it changes none (or none outside scratch space). */
export function fileChangesOf(
	toolName: string,
	args: Record<string, unknown>,
	cwd = process.cwd(),
	protectedPaths: readonly string[] = [],
): FileChanges | undefined {
	if (FILE_TOOLS.has(toolName) && typeof args.path === "string") return { paths: [args.path], dirs: [] };
	if (COMMAND_TOOLS.has(toolName) && typeof args.command === "string") {
		const effect = commandEffect(args.command, cwd, protectedPaths);
		if (!effect.changesFiles) return undefined;
		return { paths: effect.paths, dirs: effect.dirs, untraced: effect.unknownChange ? args.command : undefined };
	}
	return undefined;
}

/** True when this tool run changed (or tried to change) files. A failed edit/write changed nothing. */
export function runChangesFiles(run: ToolRun, cwd = process.cwd(), protectedPaths: readonly string[] = []): boolean {
	if (FILE_TOOLS.has(run.name)) return !run.isError;
	if (COMMAND_TOOLS.has(run.name) && run.command) return commandEffect(run.command, cwd, protectedPaths).changesFiles;
	return false;
}

/** Node's own help/version flags exit before the entrypoint; flags after a script belong to that application. */
function nodeInformationOnly(args: string[]): boolean {
	if (args.length === 0) return true;
	const info = new Set(["--help", "-h", "--version", "-v", "--v8-options"]);
	if (!args.some((arg) => info.has(arg))) return false;
	const values = new Set([
		"-e",
		"--eval",
		"-p",
		"--print",
		"-r",
		"--require",
		"--import",
		"--loader",
		"--experimental-loader",
		"--input-type",
		"--conditions",
		"-C",
	]);
	const switches = new Set([
		"--test",
		"--test-only",
		"--no-warnings",
		"--trace-warnings",
		"--enable-source-maps",
		"--experimental-strip-types",
		"--inspect",
		"--inspect-brk",
		"--watch",
	]);
	let uncertain = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (info.has(arg)) return true;
		if (arg === "--" || arg === "-") return false;
		if (values.has(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) return uncertain && args.slice(i + 1).some((rest) => info.has(rest));
		// Unknown option arity cannot establish that a following positional token is the application.
		if (!arg.includes("=") && !switches.has(arg)) uncertain = true;
	}
	return false;
}

function informationOnly(args: string[]): boolean {
	return args.some((arg) => ["--help", "--version", "-h", "-V"].includes(arg));
}

/** Recognized execution, not merely information, a compiler/linter or a shell control word. No claim about test quality. */
function executesRuntime(segment: string, depth = 0): boolean {
	let tokens = tokenize(segment);
	while (tokens.length && (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])))
		tokens = tokens.slice(1);
	let name =
		(tokens.shift() ?? "")
			.split(/[\\/]/)
			.pop()
			?.replace(/\.exe$/i, "")
			.toLowerCase() ?? "";
	if (
		["pnpm", "yarn"].includes(name) &&
		(tokens[0] === "test" || (tokens[0] === "run" && /^(test|verify|integration)(?:$|[:.-])/.test(tokens[1] ?? "")))
	)
		return !informationOnly(tokens);
	if (["npx", "pnpm", "yarn", "uv", "poetry"].includes(name)) {
		const executable = tokens.findIndex((arg) => !arg.startsWith("-"));
		if (informationOnly(tokens.slice(0, executable < 0 ? tokens.length : executable))) return false;
		while (tokens[0]?.startsWith("-") || tokens[0] === "exec" || tokens[0] === "run") tokens.shift();
		name =
			(tokens.shift() ?? "")
				.split(/[\\/]/)
				.pop()
				?.replace(/\.exe$/i, "")
				.toLowerCase() ?? "";
	}
	if (name === "node" ? nodeInformationOnly(tokens) : informationOnly(tokens)) return false;
	if (name === "perl" && tokens.includes("-v")) return false;
	const runner = /^python[0-9.]*$/.test(name) && tokens.includes("-m") ? tokens[tokens.indexOf("-m") + 1] : name;
	if (
		["pytest", "vitest", "jest", "mocha", "ava", "go", "cargo", "dotnet"].includes(runner) &&
		tokens.some(
			(arg) =>
				["--collect-only", "--co", "--listTests", "--showConfig", "--list-tests", "--list", "-list"].includes(
					arg,
				) || arg.startsWith("-list="),
		)
	)
		return false;
	if (name === "vitest" && tokens[0] === "list") return false;
	if (name === "deno" && ["info", "types", "help", "completions"].includes(tokens[0])) return false;
	if (name === "bun" && ["build", "pm", "help"].includes(tokens[0])) return false;
	if (
		READ_ONLY_COMMANDS.has(name) ||
		["tsc", "tsgo", "eslint", "biome", "ruff", "black", "prettier", "gofmt"].includes(name)
	)
		return false;
	if (name === "node" && tokens.some((arg) => ["--check", "-c"].includes(arg))) return false;
	if (["ruby", "perl"].includes(name) && tokens.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) return false;
	if (
		/^python[0-9.]*$/.test(name) &&
		tokens.includes("-m") &&
		tokens.some((arg) => ["py_compile", "compileall"].includes(arg))
	)
		return false;
	if (["go", "cargo", "dotnet"].includes(name)) return tokens[0] === "test" || tokens[0] === "run";
	if (name === "npm")
		return (
			tokens[0] === "test" || (tokens[0] === "run" && /^(test|verify|integration)(?:$|[:.-])/.test(tokens[1] ?? ""))
		);
	if (["bash", "sh", "zsh", "powershell", "pwsh"].includes(name)) {
		if (tokens.some((arg) => /^-[a-z]*n[a-z]*$/.test(arg) || arg === "--noexec")) return false;
		const inline = tokens.findIndex((arg) => /^-[a-z]*c$/i.test(arg) || arg.toLowerCase() === "-command");
		if (inline >= 0) return depth < 3 && runtimeBody(tokens[inline + 1] ?? "", depth + 1);
		return tokens.some((arg) => /\.(sh|ps1)$/.test(arg));
	}
	return (
		/^(node|python[0-9.]*|ruby|perl|deno|bun|pytest|vitest|jest|mocha|ava|curl|http|invoke-pester)$/i.test(name) ||
		/\.(sh|ps1)$/.test(name)
	);
}

function runtimeBody(command: string, depth = 0): boolean {
	const lines = commandLines(command.trim()).lines;
	const plain = lines.map(unquoted).join("\n");
	// These shapes can report success without reaching a runtime branch, waiting for it, or preserving its failure.
	if (/\|\||(?:^|[^>&])&(?![>&])|(?:^|[;\n])\s*(?:if|for|while|until|case|eval|source)\b/.test(plain)) return false;
	const segments = lines.flatMap(splitSegments);
	if (/[;\n]/.test(plain)) {
		const first = tokenize(segments[0] ?? "");
		if (first[0] !== "set" || !first.some((arg) => /^-[a-z]*e[a-z]*$/.test(arg))) return false;
	}
	if (/(?<!\|)\|(?!\|)/.test(plain)) {
		const setting = segments
			.map(tokenize)
			.filter((tokens) => tokens[0] === "set" && tokens.includes("pipefail"))
			.at(-1);
		if (!setting?.some((arg) => /^-[a-z]*o$/.test(arg))) return false;
	}
	return segments.some((part) => executesRuntime(part, depth));
}

/** A recognized runtime command with no source/unknown writes; isolated artifacts are permitted. */
export function isCheckCommand(run: ToolRun, cwd = process.cwd(), protectedPaths: readonly string[] = []): boolean {
	if (!COMMAND_TOOLS.has(run.name) || run.command === undefined) return false;
	const effect = commandEffect(run.command, cwd, protectedPaths);
	return !effect.readOnly && !effect.changesFiles && runtimeBody(run.command);
}

/**
 * Whether a passing check command ran after this run's last file change. `lastCheck` is the latest
 * check command after that change, passing or not; without one there is nothing to show.
 */
export function checkAfterLastChange(
	runs: ToolRun[],
	command?: string,
	cwd = process.cwd(),
	after?: string,
): { changed: boolean; lastCheck?: ToolRun; lastChange?: ToolRun } {
	const protectedPaths = runs.filter((run) => FILE_TOOLS.has(run.name) && run.path).map((run) => run.path as string);
	let lastChangeIndex = -1;
	runs.forEach((run, i) => {
		if (runChangesFiles(run, cwd, protectedPaths)) lastChangeIndex = i;
	});
	const lastCheck = runs
		.slice(Math.max(lastChangeIndex, after === undefined ? -1 : runs.findIndex((run) => run.id === after)) + 1)
		.filter(
			(run) =>
				isCheckCommand(run, cwd, protectedPaths) &&
				(command === undefined || run.command?.trim() === command.trim()),
		)
		.pop();
	return { changed: lastChangeIndex >= 0, lastCheck, lastChange: runs[lastChangeIndex] };
}
