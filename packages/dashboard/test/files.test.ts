import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deletePath, FileConflictError, listDirectory, readTextFile, renamePath, writeTextFile } from "../src/files.ts";

test("dashboard file workbench edits safely and renames paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "theoses-dashboard-"));
	const folder = join(root, "folder");
	await writeFile(join(root, "note.md"), "before\n");
	await mkdir(folder);

	const nodes = await listDirectory(root);
	assert.equal(nodes[0]?.name, "folder");
	const opened = await readTextFile(join(root, "note.md"));
	const saved = await writeTextFile(opened.path, "after\n", opened.version);
	assert.equal(saved.content, "after\n");
	await assert.rejects(() => writeTextFile(opened.path, "stale\n", opened.version), FileConflictError);

	const renamed = await renamePath(folder, "renamed");
	assert.equal(renamed.newPath, join(root, "renamed"));
	assert.equal(await readFile(join(root, "note.md"), "utf8"), "after\n");

	await deletePath(join(root, "note.md"));
	const remaining = await listDirectory(root);
	assert.equal(remaining.some((entry) => entry.name === "note.md"), false);
});
