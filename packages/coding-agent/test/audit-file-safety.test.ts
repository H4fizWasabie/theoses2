import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "theoses-file-safety-"));
	directories.push(cwd);
	return { cwd };
}

describe("coding-agent file safety", () => {
	it.each([false, true])("serializes symlinked missing paths (create before second call: %s)", async (createFirst) => {
		const { cwd } = await setup();
		await mkdir(join(cwd, "real"));
		await symlink(join(cwd, "real"), join(cwd, "alias"), "dir");
		const target = join(cwd, "real", "nested", "new.txt");
		const alias = join(cwd, "alias", "nested", "new.txt");
		const order: string[] = [];
		let second: Promise<void> | undefined;
		await withFileMutationQueue(alias, async () => {
			if (createFirst) {
				await mkdir(join(cwd, "real", "nested"));
				await writeFile(target, "first");
			}
			second = withFileMutationQueue(target, async () => {
				order.push("second");
			});
			// A different file is a registration barrier, without waiting for the queued mutation.
			await withFileMutationQueue(join(cwd, "barrier"), async () => {});
			order.push("first");
		});
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("reports recovered paths and prefers an exact Unicode filename", async () => {
		const { cwd } = await setup();
		const read = (path: string) => createReadTool(cwd).execute("read", { path });
		const actual = join(cwd, "can’t.txt");
		await writeFile(actual, "recovered");
		const result = await read("can't.txt");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining(actual) }),
		);
		await writeFile(join(cwd, "a b.txt"), "wrong");
		await writeFile(join(cwd, "a b.txt"), "exact");
		const exact = await read("a b.txt");
		expect(exact.content).toEqual([{ type: "text", text: "exact" }]);
		expect(await readFile(actual, "utf8")).toBe("recovered");
	});
});
