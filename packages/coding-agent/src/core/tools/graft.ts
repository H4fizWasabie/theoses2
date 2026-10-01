import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { TOOL_OUTPUT_MAX_BYTES, TOOL_OUTPUT_MAX_LINES, truncateHead } from "./truncate.ts";

const execFileAsync = promisify(execFile);
export const GRAFT_TIMEOUT_MS = 10_000;
export const GRAFT_MAX_BUFFER = 128 * 1024;

const graftSchema = Type.Object(
	{
		command: Type.Union([Type.Literal("ask"), Type.Literal("skeleton"), Type.Literal("callers")]),
		target: Type.String({
			minLength: 1,
			maxLength: 500,
			description: "Short identifier/query for ask, repo-relative file for skeleton, or symbol for callers",
		}),
		path: Type.Optional(Type.String({ description: "Repository directory (default: nearest graph above cwd)" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "ask results (default: 4)" })),
		depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "callers depth (default: 1)" })),
	},
	{ additionalProperties: false },
);
export type GraftToolInput = Static<typeof graftSchema>;

interface GraftToolDetails {
	available: boolean;
	repository: string;
	truncated?: boolean;
}

/** An explicit path never silently falls back to a different repository's graph. */
function graphRoot(cwd: string, path?: string): string {
	const start = resolve(cwd, path ?? ".");
	if (path !== undefined) return start;
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "graft", ".graph", "wiring.json"))) return dir;
		// Do not answer from a parent repository when this nested repository has no graph.
		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return start;
	}
}

/** Fixed options plus two positional arguments after `--`: no shell or caller-supplied CLI flags. */
function queryArgs(input: GraftToolInput, repository: string): string[] {
	if (Object.keys(input).some((key) => !["command", "target", "path", "limit", "depth"].includes(key))) {
		throw new Error(
			"Graft accepts only command, target, path, limit and depth; arbitrary CLI options are forbidden.",
		);
	}
	if (
		typeof input.target !== "string" ||
		!input.target.trim() ||
		input.target.length > 500 ||
		/[\x00-\x1f\x7f]/.test(input.target)
	) {
		throw new Error("Graft target must be a nonempty, single-line query of at most 500 characters.");
	}
	if (input.target.trimStart().startsWith("-")) throw new Error("Graft target cannot be a CLI option.");
	if (
		input.path !== undefined &&
		(typeof input.path !== "string" || !input.path.trim() || /[\x00-\x1f\x7f]/.test(input.path))
	) {
		throw new Error("Graft path must be a nonempty directory path without control characters.");
	}
	if (
		input.limit !== undefined &&
		(!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8 || input.command !== "ask")
	) {
		throw new Error("Graft limit is only valid for ask and must be an integer from 1 to 8.");
	}
	if (
		input.depth !== undefined &&
		(!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 3 || input.command !== "callers")
	) {
		throw new Error("Graft depth is only valid for callers and must be an integer from 1 to 3.");
	}
	const args = [input.command, "--no-refresh"];
	switch (input.command) {
		case "ask":
			args.push("--source", "--limit", String(input.limit ?? 4));
			break;
		case "skeleton":
			if (isAbsolute(input.target) || win32.isAbsolute(input.target) || input.target.split(/[\\/]/).includes("..")) {
				throw new Error("Graft skeleton requires a repository-relative file without parent traversal.");
			}
			break;
		case "callers":
			args.push("--depth", String(input.depth ?? 1));
			break;
		default:
			throw new Error("Only Graft ask, skeleton and callers are allowed; no build, refresh or shell commands.");
	}
	return [...args, "--", input.target, repository];
}

export function createGraftToolDefinition(cwd: string): ToolDefinition<typeof graftSchema, GraftToolDetails> {
	return {
		name: "graft",
		label: "graft",
		description:
			"Query an existing Graft code graph: ask (with source), skeleton (file signatures), or callers (references). Prefer this before raw searches. No shell, build or automatic graph refresh. Missing graph/binary: use read/grep/find/ls and ask the parent to prepare Graft. Existing graphs may be stale; verify important source locations with read.",
		parameters: graftSchema,
		async execute(_toolCallId, input: GraftToolInput, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			// Validate before resolving paths or spawning anything.
			queryArgs(input, resolve(cwd));
			const repository = graphRoot(cwd, input.path);
			const args = queryArgs(input, repository);
			if (!existsSync(join(repository, "graft", ".graph", "wiring.json"))) {
				return {
					content: [
						{
							type: "text",
							text: `No existing Graft wiring graph at ${repository}/graft. Use read/grep/find/ls, or ask the parent to run graft build for this repository. This is not evidence that the code is absent.`,
						},
					],
					details: { available: false, repository },
				};
			}
			let stdout: string;
			let stderr: string;
			let bufferLimited = false;
			try {
				({ stdout, stderr } = await execFileAsync("graft", args, {
					cwd: repository,
					shell: false,
					timeout: GRAFT_TIMEOUT_MS,
					killSignal: "SIGKILL",
					maxBuffer: GRAFT_MAX_BUFFER,
					encoding: "utf8",
					signal,
					// The third-party CLI must not inherit provider keys or Node injection options.
					env: { PATH: process.env.PATH, HOME: process.env.HOME, DO_NOT_TRACK: "1", NO_COLOR: "1" },
				}));
			} catch (error) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const failure = error as Error & {
					code?: string | number;
					killed?: boolean;
					stdout?: string;
					stderr?: string;
				};
				if (failure.code === "ENOENT") {
					return {
						content: [
							{
								type: "text",
								text: "Graft is not available on PATH. Use read/grep/find/ls; ask the parent to install or configure Graft. No code search was performed.",
							},
						],
						details: { available: false, repository },
					};
				}
				if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					stdout = failure.stdout ?? "";
					stderr = failure.stderr ?? "";
					bufferLimited = true;
				} else {
					const reason = failure.killed ? "exceeded its 10-second time limit" : failure.stderr || failure.message;
					throw new Error(
						`Graft query failed: ${truncateHead(reason, { maxLines: TOOL_OUTPUT_MAX_LINES, maxBytes: TOOL_OUTPUT_MAX_BYTES }).content || "diagnostic exceeded output limit"}. Use read/grep/find/ls as fallback.`,
					);
				}
			}
			const shaped = truncateHead([stdout, stderr].filter(Boolean).join("\n"), {
				maxLines: TOOL_OUTPUT_MAX_LINES,
				maxBytes: TOOL_OUTPUT_MAX_BYTES,
			});
			const truncated = bufferLimited || shaped.truncated;
			return {
				content: [
					{
						type: "text",
						text: `${shaped.content || "Graft returned no output."}${truncated ? "\n[truncated: narrow the query or read the referenced source files]" : ""}\n[existing graph; refresh disabled — verify important locations with read]`,
					},
				],
				details: { available: true, repository, truncated },
			};
		},
	};
}
