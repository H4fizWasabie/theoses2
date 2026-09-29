import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "theoses-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { BUSY_DIR_NAME, markBusy } from "../../src/core/busy-marker.ts";
import { createHarness, type Harness } from "./harness.ts";

function markers(agentDir: string): string[] {
	try {
		return readdirSync(join(agentDir, BUSY_DIR_NAME));
	} catch {
		return [];
	}
}

describe("busy marker", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "busy-marker-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("leaves <pid>-<session> while marked and removes it on release", () => {
		const release = markBusy("s1", agentDir);
		expect(markers(agentDir)).toEqual([`${process.pid}-s1`]);
		release();
		expect(markers(agentDir)).toEqual([]);
	});

	it("does not throw when the marker cannot be written", () => {
		const blocked = join(agentDir, "not-a-directory");
		writeFileSync(blocked, "");
		expect(() => markBusy("s1", blocked)()).not.toThrow();
	});

	it("marks a session busy for the whole operation and clears it afterwards", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		const seenWhileRunning: string[][] = [];
		h.session.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "agent_end") seenWhileRunning.push(markers(agentDir));
		});

		await h.session.prompt("hi");

		const expected = [`${process.pid}-${h.session.sessionId}`];
		expect(seenWhileRunning).toEqual([expected, expected]);
		expect(markers(agentDir)).toEqual([]);
	});
});
