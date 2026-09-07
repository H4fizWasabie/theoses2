import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../agent/src/harness/env/nodejs.ts";
import { withFileMutationQueue as withHarnessQueue } from "../../agent/src/harness/tools/file-mutation-queue.ts";
import { createReadTool as createHarnessRead } from "../../agent/src/harness/tools/read.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "theoses-file-safety-"));
	directories.push(cwd);
	return { cwd, env: new NodeExecutionEnv({ cwd }) };
}

describe.each(["coding-agent", "harness"])("%s file safety", (implementation) => {
	it.each([false, true])("serializes symlinked missing paths (create before second call: %s)", async (createFirst) => {
		const { cwd, env } = await setup();
		await mkdir(join(cwd, "real"));
		await symlink(join(cwd, "real"), join(cwd, "alias"), "dir");
		const target = join(cwd, "real", "nested", "new.txt");
		const alias = join(cwd, "alias", "nested", "new.txt");
		const queue = <T>(path: string, fn: () => Promise<T>) =>
			implementation === "harness" ? withHarnessQueue(env, path, fn) : withFileMutationQueue(path, fn);
		const order: string[] = [];
		let second: Promise<void> | undefined;
		await queue(alias, async () => {
			if (createFirst) {
				await mkdir(join(cwd, "real", "nested"));
				await writeFile(target, "first");
			}
			second = queue(target, async () => {
				order.push("second");
			});
			// A different file is a registration barrier, without waiting for the queued mutation.
			await queue(join(cwd, "barrier"), async () => {});
			order.push("first");
		});
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("reports recovered paths and prefers an exact Unicode filename", async () => {
		const { cwd, env } = await setup();
		const read = (path: string) =>
			implementation === "harness"
				? createHarnessRead().execute("read", { path }, undefined, undefined, { env })
				: createReadTool(cwd).execute("read", { path });
		const actual = join(cwd, "can’t.txt");
		await writeFile(actual, "recovered");
		const result = await read("can't.txt");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining(actual) }),
		);
		await writeFile(join(cwd, "a b.txt"), "wrong");
		await writeFile(join(cwd, "a\u00a0b.txt"), "exact");
		const exact = await read("a\u00a0b.txt");
		expect(exact.content).toEqual([{ type: "text", text: "exact" }]);
		expect(await readFile(actual, "utf8")).toBe("recovered");
	});
});
