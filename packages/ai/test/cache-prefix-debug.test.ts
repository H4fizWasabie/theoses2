import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logCachePrefixDiff } from "../src/api/cache-prefix-debug.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

describe("logCachePrefixDiff", () => {
	let lines: string[];

	beforeEach(() => {
		lines = [];
		vi.spyOn(console, "error").mockImplementation((line: string) => {
			lines.push(line);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports append-only growth as an intact prefix", () => {
		logCachePrefixDiff("sess-intact", { messages: [user("a")] });
		logCachePrefixDiff("sess-intact", { messages: [user("a"), assistant("b"), user("c")] });
		expect(lines[0]).toContain("first request");
		expect(lines[1]).toContain("prefix intact");
	});

	it("reports the first rewritten message index with before and after snippets", () => {
		logCachePrefixDiff("sess-broken", { messages: [user("a"), assistant("old reply"), user("c")] });
		logCachePrefixDiff("sess-broken", { messages: [user("a"), assistant("new reply"), user("c"), user("d")] });
		expect(lines[1]).toContain("PREFIX_BROKEN at=1");
		expect(lines[1]).toContain("old reply");
		expect(lines[1]).toContain("new reply");
	});

	it("flags changed tools and params", () => {
		logCachePrefixDiff("sess-tools", { messages: [user("a")], tools: [{ name: "x" }], model: "m" });
		logCachePrefixDiff("sess-tools", { messages: [user("a")], tools: [{ name: "y" }], model: "n" });
		expect(lines[1]).toContain("TOOLS_CHANGED");
		expect(lines[1]).toContain("PARAMS_CHANGED");
	});
});
