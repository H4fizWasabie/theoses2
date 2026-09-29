import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const swept = vi.hoisted(() => ({ directories: [] as string[] }));

vi.mock("../../src/core/file-checkpoints.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/file-checkpoints.ts")>();
	return {
		...actual,
		sweepCheckpoints: (directory: string, ...rest: [number?, number?]) => {
			swept.directories.push(directory);
			return actual.sweepCheckpoints(directory, ...rest);
		},
	};
});

describe("AgentSession sweeps old checkpoint bytes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		swept.directories.length = 0;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("sweeps the checkpoint directory of a persisted session when it starts", async () => {
		const harness = await createHarness({ persist: true });
		harnesses.push(harness);

		expect(swept.directories).toEqual([join(harness.tempDir, "sessions", "checkpoints")]);
	});

	it("does not sweep for a session that is not persisted", async () => {
		harnesses.push(await createHarness());

		expect(swept.directories).toEqual([]);
	});
});
