#!/usr/bin/env node
// PostToolUse command hook (packages/coding-agent/docs/hooks.md): tells the model the git state of the repo a
// bash, edit or write call just worked in - branch, commit, distance from its upstream, nearest tag, uncommitted
// changes. Without it the agent branched from a stale main and could not say which release a branch started
// from (issue #530).
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

const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|$)/;

/** The directory the call worked in: a file tool's target, a bash command's leading `cd`, else the session's cwd. */
function workDir(event) {
	const cwd = event.cwd ?? process.cwd();
	const input = event.toolInput ?? {};
	if (typeof input.path === "string") return dirname(resolve(cwd, input.path));
	const cd = typeof input.command === "string" ? LEADING_CD.exec(input.command) : null;
	if (!cd) return cwd;
	const target = cd[1].replace(/^["']|["']$/g, "");
	return resolve(cwd, target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : target);
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
const top = git(workDir(event), "rev-parse", "--show-toplevel");
if (top) {
	const { key, text } = describeRepo(top);
	const stateDir = process.env.THEOSES_GIT_STATE_DIR ?? join(tmpdir(), "theoses-git-state");
	const stateFile = join(stateDir, `${String(event.sessionId ?? "unknown").replace(/[^\w.-]/g, "_")}.json`);
	let said = {};
	try {
		said = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {}
	if (said[top] !== key) {
		said[top] = key;
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify(said));
		process.stdout.write(JSON.stringify({ additionalContext: text }));
	}
}
