import { describe, expect, it } from "vitest";
import { parseStructuredJson, stripStrayStructuralChars, stripTrailingCommas } from "../src/core/structured-output.ts";

describe("stripStrayStructuralChars", () => {
	it("removes zero-width and control characters between tokens", () => {
		expect(stripStrayStructuralChars('{"a": 1,​"b": [2\u001b]}')).toBe('{"a": 1,"b": [2]}');
	});

	it("keeps ordinary whitespace between tokens", () => {
		const input = '{\n\t"a": 1,\r\n "b": 2\n}';
		expect(stripStrayStructuralChars(input)).toBe(input);
	});

	it("leaves characters inside string values untouched", () => {
		const input = '{"body": "zero​width and \\" quote​"}';
		expect(stripStrayStructuralChars(input)).toBe(input);
	});
});

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

	it("repairs a zero-width character between array and key (production failure, 2026-09-19 10:05)", () => {
		const raw =
			'{"facts":[],\n  "edges": [\n    {"from": "f0", "to": "n1", "rel": "related_to"}\n  ],\n ​"episode": {"summary": "s"}\n}';
		expect(parseStructuredJson(raw, "test")).toEqual({
			facts: [],
			edges: [{ from: "f0", to: "n1", rel: "related_to" }],
			episode: { summary: "s" },
		});
	});

	it("repairs an ESC character before a closing bracket (production failure, 2026-09-19 12:09)", () => {
		const raw =
			'{"edges": [\n    {"from": "f11", "to": "n2", "rel": "supersedes"}\n \u001b],\n  "episode": {"summary": "s"}\n}';
		expect(parseStructuredJson(raw, "test")).toEqual({
			edges: [{ from: "f11", to: "n2", rel: "supersedes" }],
			episode: { summary: "s" },
		});
	});

	it("throws and includes position + raw snippet for hopeless JSON", () => {
		const bad = '{"facts":[{"id":"f1","subject":"a " b"}]}';
		expect(() => parseStructuredJson(bad, "Memory consolidation")).toThrow();
	});
});
