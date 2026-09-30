import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

// A model that repeats an edit that already landed got "might indicate an issue with special characters or the text not
// existing" and retried the same edit five times in a row (Telegram session, 2026-09-30). The message has to say what is
// true: the file already reads this way, so there is nothing to do.
describe("edit that changes nothing", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-noop-"));
		writeFileSync(join(dir, "a.txt"), "limit = 100\nname = x\n");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const attempt = (edits: Array<{ oldText: string; newText: string }>) =>
		createEditToolDefinition(dir).execute(
			"call",
			{ path: "a.txt", edits },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

	it("says the file already contains the text and not to repeat the edit", async () => {
		await expect(attempt([{ oldText: "limit = 100", newText: "limit = 100" }])).rejects.toThrow(
			/already (contains|reads)[^.]*\. .*do not repeat/is,
		);
	});

	it("says the same when several edits change nothing", async () => {
		await expect(
			attempt([
				{ oldText: "limit = 100", newText: "limit = 100" },
				{ oldText: "name = x", newText: "name = x" },
			]),
		).rejects.toThrow(/already (contain|read)[^.]*\. .*do not repeat/is);
	});

	it("does not blame special characters", async () => {
		await expect(attempt([{ oldText: "limit = 100", newText: "limit = 100" }])).rejects.not.toThrow(
			/special characters/,
		);
	});
});
