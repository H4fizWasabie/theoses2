import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	describeResponseShape,
	MAX_FAILED_BACKGROUND_RESPONSES,
	recordBackgroundFailure,
} from "../src/core/background-failure-log.ts";

describe("describeResponseShape", () => {
	it("names the stop reason, the keys and a slice of the text", () => {
		expect(describeResponseShape("{}", "stop")).toBe('stopReason=stop, keys=[], text="{}"');
		expect(describeResponseShape('{"facts":[],"edges":[]}', "length")).toContain("keys=[facts,edges]");
	});

	it("distinguishes non-objects and non-JSON, and truncates long text to 300 characters", () => {
		expect(describeResponseShape("[1]")).toContain("stopReason=unknown, keys=array");
		expect(describeResponseShape("oops")).toContain("keys=not-json");
		const long = describeResponseShape(`{"a":"${"x".repeat(500)}"}`, "stop");
		expect(long.length).toBeLessThan(400);
	});
});

describe("recordBackgroundFailure", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bg-failure-"));
		path = join(dir, "failed.jsonl");
		process.env.THEOSES_BACKGROUND_FAILURE_LOG = path;
	});
	afterEach(() => {
		delete process.env.THEOSES_BACKGROUND_FAILURE_LOG;
		rmSync(dir, { recursive: true, force: true });
	});

	const entry = (n: number) => ({
		caller: "consolidation",
		model: "deepseek/deepseek-v4-flash-0731",
		provider: "DeepInfra",
		stopReason: "stop",
		error: `failure ${n}`,
		reply: "{}",
	});

	it("writes one JSON line per failure with the full reply", () => {
		recordBackgroundFailure(entry(1));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toMatchObject({
			caller: "consolidation",
			provider: "DeepInfra",
			reply: "{}",
		});
	});

	it("keeps only the newest MAX_FAILED_BACKGROUND_RESPONSES entries", () => {
		for (let i = 0; i < MAX_FAILED_BACKGROUND_RESPONSES + 5; i++) recordBackgroundFailure(entry(i));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(MAX_FAILED_BACKGROUND_RESPONSES);
		expect(JSON.parse(lines[0] as string).error).toBe("failure 5");
		expect(JSON.parse(lines.at(-1) as string).error).toBe(`failure ${MAX_FAILED_BACKGROUND_RESPONSES + 4}`);
	});

	it("never throws when the path cannot be written", () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.THEOSES_BACKGROUND_FAILURE_LOG = join(blocker, "nested.jsonl");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => recordBackgroundFailure(entry(1))).not.toThrow();
		expect(errorSpy).toHaveBeenCalledWith("Background failure log write failed:", expect.any(String));
		errorSpy.mockRestore();
	});
});
