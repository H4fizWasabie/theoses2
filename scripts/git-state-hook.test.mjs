import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hookScript = fileURLToPath(new URL("./git-state-hook.mjs", import.meta.url));

function git(dir, ...args) {
	execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/** A repo with one tagged commit on main and a clone of it tracking origin/main, plus a hook state dir. */
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "git-state-hook-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const origin = join(root, "origin");
	const clone = join(root, "clone");
	execFileSync("git", ["init", "-q", "-b", "main", origin]);
	git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
	git(origin, "tag", "v1.0.0");
	execFileSync("git", ["clone", "-q", origin, clone]);
	return { root, origin, clone, stateDir: join(root, "state") };
}

function runHook(stateDir, event) {
	const result = spawnSync("node", [hookScript], {
		input: JSON.stringify({ event: "PostToolUse", sessionId: "s1", ...event }),
		env: { ...process.env, THEOSES_GIT_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout ? JSON.parse(result.stdout).additionalContext : undefined;
}

test("reports a stale clone's distance from upstream, its tag and its changes once", async (t) => {
	const { origin, clone, stateDir } = await fixture(t);
	git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
	git(clone, "fetch", "-q");
	await writeFile(join(clone, "a.txt"), "a");

	const bash = { toolName: "bash", cwd: "/", toolInput: { command: `cd ${clone} && git status` } };
	const text = runHook(stateDir, bash);

	assert.match(text, /is on branch main at [0-9a-f]+/);
	assert.match(text, /1 behind and 0 ahead of origin\/main as of the last fetch/);
	assert.match(text, /nearest tag v1\.0\.0/);
	assert.match(text, /1 uncommitted change\./);
	// Same branch and commit: nothing more to say, even after another edit.
	await writeFile(join(clone, "b.txt"), "b");
	assert.equal(runHook(stateDir, { toolName: "edit", cwd: "/", toolInput: { path: join(clone, "b.txt") } }), undefined);
});

test("speaks again when the branch changes", async (t) => {
	const { clone, stateDir } = await fixture(t);
	runHook(stateDir, { toolName: "bash", cwd: clone, toolInput: { command: "ls" } });

	git(clone, "checkout", "-q", "-b", "fix/thing");
	const text = runHook(stateDir, { toolName: "bash", cwd: clone, toolInput: { command: "git log -1" } });

	assert.match(text, /is on branch fix\/thing at [0-9a-f]+, no upstream, nearest tag v1\.0\.0/);
});

test("says nothing outside a git repo", async (t) => {
	const { root, stateDir } = await fixture(t);
	assert.equal(runHook(stateDir, { toolName: "bash", cwd: root, toolInput: { command: "ls" } }), undefined);
});
