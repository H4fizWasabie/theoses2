#!/usr/bin/env node
// PostToolUse command hook (packages/coding-agent/docs/hooks.md): tells the model the git state of the repo a
// bash, edit or write call just worked in - branch, commit, distance from its upstream, nearest tag, uncommitted
// changes. Without it the agent branched from a stale main and could not say which release a branch started
// from (issue #530). For bash, every repo the command reaches through `cd` or `git -C` is reported, one per line.
//
// Said once per repo per session, and again only when the branch or commit changes, so non-coding turns and
// repeated edits add nothing. The text rides on the tool result, appended at the end of the conversation, so
// the cached prompt prefix is untouched.
//
// settings.json:
//   "hooks": { "PostToolUse": [{ "matcher": "^(bash|edit|write)$",
//     "command": "node /opt/theoses2-releases/current/source/scripts/git-state-hook.mjs", "timeout": 10 }] }
//
// THEOSES_GIT_STATE_DIR overrides where the per-session record of what was already said lives.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|()]+)`;
// A `cd` that starts a command (at the start, or after &&, ||, ;, |, a newline or an opening paren), or any `git -C`.
const DIR_CHANGES = new RegExp(String.raw`(?:^|&&|\|\||[;|(\n])\s*cd\s+${ARG}|\bgit\s+-C\s+${ARG}`, "g");

function expand(arg, from) {
	const target = arg.replace(/^["']|["']$/g, "");
	return resolve(from, target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : target);
}

/**
 * The directories the call worked in: a file tool's target; for bash every `cd` and `git -C` target, each `cd`
 * resolved from the one before it (`cd repos && cd app`); else the session's cwd. A `cd` inside a subshell is
 * treated as if it stayed, which at worst names one directory too many.
 */
function workDirs(event) {
	const cwd = event.cwd ?? process.cwd();
	const input = event.toolInput ?? {};
	if (typeof input.path === "string") return [dirname(resolve(cwd, input.path))];
	if (typeof input.command !== "string") return [cwd];
	const dirs = [];
	let current = cwd;
	for (const [, cdArg, gitArg] of input.command.matchAll(DIR_CHANGES)) {
		if (cdArg) {
			current = expand(cdArg, current);
			dirs.push(current);
		} else {
			dirs.push(expand(gitArg, current));
		}
	}
	return dirs.length > 0 ? dirs : [cwd];
}

function git(dir, ...args) {
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
	} catch {
		return undefined;
	}
}

function describeRepo(top) {
	const branch = git(top, "rev-parse", "--abbrev-ref", "HEAD") ?? "?";
	const commit = git(top, "rev-parse", "--short", "HEAD") ?? "no commits";
	const parts = [`git: ${top} is on ${branch === "HEAD" ? "a detached HEAD" : `branch ${branch}`} at ${commit}`];
	const upstream = git(top, "rev-parse", "--abbrev-ref", "@{upstream}");
	const counts = upstream && git(top, "rev-list", "--left-right", "--count", "@{upstream}...HEAD");
	if (upstream && counts) {
		const [behind, ahead] = counts.split(/\s+/);
		parts.push(`${behind} behind and ${ahead} ahead of ${upstream} as of the last fetch`);
	} else {
		parts.push("no upstream");
	}
	const tag = git(top, "describe", "--tags", "--abbrev=0");
	if (tag) parts.push(`nearest tag ${tag}`);
	const changed = (git(top, "status", "--porcelain") ?? "").split("\n").filter(Boolean).length;
	parts.push(changed === 0 ? "no uncommitted changes" : `${changed} uncommitted change${changed === 1 ? "" : "s"}`);
	return { key: `${branch} ${commit}`, text: `${parts.join(", ")}.` };
}

const event = JSON.parse(readFileSync(0, "utf8"));
const tops = new Set(workDirs(event).map((dir) => git(dir, "rev-parse", "--show-toplevel")).filter(Boolean));
if (tops.size > 0) {
	const stateDir = process.env.THEOSES_GIT_STATE_DIR ?? join(tmpdir(), "theoses-git-state");
	const stateFile = join(stateDir, `${String(event.sessionId ?? "unknown").replace(/[^\w.-]/g, "_")}.json`);
	let said = {};
	try {
		said = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {}
	const lines = [];
	for (const top of tops) {
		const { key, text } = describeRepo(top);
		if (said[top] === key) continue;
		said[top] = key;
		lines.push(text);
	}
	if (lines.length > 0) {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify(said));
		process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }));
	}
}
