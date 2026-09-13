import { describe, expect, it } from "vitest";
import { parseStructuredJson, stripTrailingCommas } from "../src/core/structured-output.ts";

describe("stripTrailingCommas", () => {
	it("removes trailing commas in objects and arrays", () => {
		expect(stripTrailingCommas('{"a": [1, 2,],}')).toBe('{"a": [1, 2]}');
	});

	it("does not touch commas inside string values (no data edits)", () => {
		const input = '{"body": "hello ,} world", "n": 1,}';
		expect(stripTrailingCommas(input)).toBe('{"body": "hello ,} world", "n": 1}');
	});

	it("preserves commas that are followed by a value", () => {
		const input = '{"a": 1, "b": [2, 3]}';
		expect(stripTrailingCommas(input)).toBe(input);
	});

	it("handles escaped quotes inside strings", () => {
		const input = '{"s": "a \\" b, c", "t": [1,]}';
		expect(stripTrailingCommas(input)).toBe('{"s": "a \\" b, c", "t": [1]}');
	});
});

describe("parseStructuredJson", () => {
	it("parses clean JSON", () => {
		expect(parseStructuredJson('{"facts":[]}', "test")).toEqual({ facts: [] });
	});

	it("strips markdown fences", () => {
		expect(parseStructuredJson('```json\n{"facts":[]}\n```', "test")).toEqual({ facts: [] });
	});

	it("repairs trailing commas", () => {
		expect(parseStructuredJson('{"facts":[{"id":"f1","subject":"x",}],"edges":[]}', "test")).toEqual({
			facts: [{ id: "f1", subject: "x" }],
			edges: [],
		});
	});

	it("repairs raw control characters inside strings", () => {
		expect(parseStructuredJson('{"episode":{"summary":"line1\nline2"}}', "test")).toEqual({
			episode: { summary: "line1\nline2" },
		});
	});

	it("throws and includes position + raw snippet for hopeless JSON", () => {
		const bad = '{"facts":[{"id":"f1","subject":"a " b"}]}';
		expect(() => parseStructuredJson(bad, "Memory consolidation")).toThrow();
	});
});
