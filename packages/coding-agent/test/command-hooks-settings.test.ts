import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function manager(user: unknown, project: unknown, projectTrusted: boolean): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ hooks: user }));
	storage.withLock("project", () => JSON.stringify({ hooks: project }));
	return SettingsManager.fromStorage(storage, { projectTrusted });
}

const commands = (m: SettingsManager, event: "PreToolUse" | "Stop") =>
	(m.getCommandHooks()[event] ?? []).map((h) => `${h.source}:${h.command}`);

describe("SettingsManager.getCommandHooks", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds a trusted project's hooks after the user's", () => {
		const m = manager(
			{ PreToolUse: [{ command: "user.sh" }] },
			{ PreToolUse: [{ command: "project.sh" }], Stop: [{ command: "stop.sh" }] },
			true,
		);
		expect(commands(m, "PreToolUse")).toEqual(["user:user.sh", "project:project.sh"]);
		expect(commands(m, "Stop")).toEqual(["project:stop.sh"]);
	});

	it("never reads an untrusted project's hooks", () => {
		const m = manager(
			{ PreToolUse: [{ command: "user.sh" }] },
			{ PreToolUse: [{ command: "evil.sh" }], Stop: [{ command: "evil-stop.sh" }] },
			false,
		);
		expect(commands(m, "PreToolUse")).toEqual(["user:user.sh"]);
		expect(commands(m, "Stop")).toEqual([]);
	});

	it("does not let a project replace the user's hooks, which is what a plain settings merge would do to an array", () => {
		const m = manager(
			{ PreToolUse: [{ command: "guard.sh", failClosed: true }] },
			{ PreToolUse: [{ command: "other.sh" }] },
			true,
		);
		expect(commands(m, "PreToolUse")[0]).toBe("user:guard.sh");
		expect(m.getCommandHooks().PreToolUse?.[0].failClosed).toBe(true);
	});

	it("is empty when nothing is configured", () => {
		expect(manager(undefined, undefined, true).getCommandHooks()).toEqual({});
	});
});

describe("SettingsManager.getExcludedModels", () => {
	function withExclusions(user: unknown, project: unknown, projectTrusted: boolean): SettingsManager {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ excludedModels: user }));
		storage.withLock("project", () => JSON.stringify({ excludedModels: project }));
		return SettingsManager.fromStorage(storage, { projectTrusted });
	}

	it("adds a trusted project's patterns to the user's, never replacing them", () => {
		expect(withExclusions(["*deepseek*"], ["*qwen*"], true).getExcludedModels()).toEqual(["*deepseek*", "*qwen*"]);
		expect(withExclusions(["*deepseek*"], [], true).getExcludedModels()).toEqual(["*deepseek*"]);
	});

	it("ignores an untrusted project's patterns, blank entries and non-strings", () => {
		expect(withExclusions(["*deepseek*", "", 3, null], ["*qwen*"], false).getExcludedModels()).toEqual([
			"*deepseek*",
		]);
	});

	it("is empty when nothing is configured", () => {
		expect(withExclusions(undefined, undefined, true).getExcludedModels()).toEqual([]);
	});
});
