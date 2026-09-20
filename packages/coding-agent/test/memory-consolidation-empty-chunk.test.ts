import { describe, expect, it } from "vitest";
import { hasConsolidationContent, isEmptyConsolidationResponse } from "../src/core/memory-consolidation.ts";

describe("hasConsolidationContent", () => {
	it("is false for an empty transcript and for lines that are only a prefix", () => {
		expect(hasConsolidationContent("")).toBe(false);
		expect(hasConsolidationContent("[2026-09-20T11:58:20.000Z] custom: ")).toBe(false);
		expect(
			hasConsolidationContent("[2026-09-20T11:58:20.000Z] custom: \n[2026-09-20T11:58:21.000Z] assistant:   "),
		).toBe(false);
	});

	it("is true as soon as one line carries text", () => {
		expect(hasConsolidationContent("[2026-09-20T11:58:12.649Z] user: Its fine. Thanks theo")).toBe(true);
		expect(
			hasConsolidationContent("[2026-09-20T11:58:20.000Z] custom: \n[2026-09-20T11:58:21.000Z] toolResult: ok"),
		).toBe(true);
	});
});

describe("isEmptyConsolidationResponse", () => {
	it("accepts the bare {} DeepInfra returns and empty lists without an episode", () => {
		expect(isEmptyConsolidationResponse("{}")).toBe(true);
		expect(isEmptyConsolidationResponse('{"facts":[],"edges":[]}')).toBe(true);
	});

	it("rejects a response that has an episode, facts, or edges", () => {
		expect(
			isEmptyConsolidationResponse(
				'{"facts":[],"edges":[],"episode":{"summary":"s","startedAt":"a","endedAt":"b"}}',
			),
		).toBe(false);
		expect(isEmptyConsolidationResponse('{"facts":[{"id":"f1","subject":"x"}]}')).toBe(false);
		expect(isEmptyConsolidationResponse('{"edges":[{"from":"a","to":"b","rel":"used_in"}]}')).toBe(false);
	});

	it("rejects non-objects and unparseable text so the real parser reports them", () => {
		expect(isEmptyConsolidationResponse("[]")).toBe(false);
		expect(isEmptyConsolidationResponse("not json")).toBe(false);
	});
});
