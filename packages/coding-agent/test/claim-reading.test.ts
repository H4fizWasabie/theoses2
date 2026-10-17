import type { AgentMessage } from "theoses-agent-core";
import type { AssistantMessage } from "theoses-ai";
import { describe, expect, it } from "vitest";
import { type Claim, readClaims } from "../src/core/claim-reading.ts";

let nextId = 0;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function reply(text: string): AssistantMessage {
	return assistant([{ type: "text", text }]);
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function bash(command: string, output: string): AgentMessage[] {
	const id = `claim-${nextId++}`;
	return [
		assistant([{ type: "toolCall", id, name: "bash", arguments: { command } }]),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: 0,
		} as AgentMessage,
	];
}

/** Incident fixture (2026-10-17): the Task's listing showed 15 untracked names and no 13. */
const LISTING = Array.from({ length: 15 }, (_, i) => `NOT TRACKED: variant-${String.fromCharCode(97 + i)}`).join("\n");

function statusOf(claims: Claim[]): Array<{ value: string; status: string }> {
	return claims.map(({ value, status }) => ({ value, status }));
}

describe("readClaims (scan mode)", () => {
	it("the 2026-10-17 incident: a count the listing does not show is a Guess", () => {
		const claims = readClaims(
			[user("which variant dirs are untracked?"), ...bash("git status --short", LISTING)],
			reply("13 of the variant dirs are untracked."),
		);
		expect(statusOf(claims)).toEqual([{ value: "13", status: "guess" }]);
	});

	it("the same count after a tool showed 15 is Grounded, citing that tool result", () => {
		const messages = [user("count the untracked names"), ...bash("wc -l untracked.txt", "15 untracked.txt")];
		const claims = readClaims(messages, reply("15 names are untracked."));
		expect(claims).toEqual([{ value: "15", status: "grounded", specificity: "small", source: "claim-1" }]);
	});

	it("a value present only in an earlier Task does not ground a Claim (caller passes this Task only)", () => {
		const currentTask = [user("and now?"), ...bash("true", "all good")];
		expect(statusOf(readClaims(currentTask, reply("there are 7 files")))).toEqual([{ value: "7", status: "guess" }]);
	});

	it("values the owner typed are not counted", () => {
		const claims = readClaims([user("check 42 items")], reply("the 42 items are fine"), "check 42 items");
		expect(claims).toEqual([]);
	});

	it("dates, times, list ordinals, versions and years are not counted", () => {
		const text = "1. On 2026-10-17 at 14:20 (Oct 14), using v1.0.129 and gpt-6.1-sol, steps:\n2) 3.5 is 3.5";
		expect(readClaims([], reply(text))).toEqual([{ value: "3.5", status: "guess", specificity: "specific" }]);
	});

	it("paths and URLs are values; numbers inside them are not", () => {
		const messages = bash("ls", "packages/a2/b.ts\nsee https://example.com/x");
		const claims = readClaims(
			messages,
			reply("Edited packages/a2/b.ts, see https://example.com/x. Also packages/c/d.ts."),
		);
		expect(statusOf(claims)).toEqual([
			{ value: "https://example.com/x", status: "grounded" },
			{ value: "packages/a2/b.ts", status: "grounded" },
			{ value: "packages/c/d.ts", status: "guess" },
		]);
	});

	it("a number glued to a currency prefix is the whole number", () => {
		const claims = readClaims(bash("cat total", "579,995.36"), reply("Total RM579,995.36."));
		expect(statusOf(claims)).toEqual([{ value: "579,995.36", status: "grounded" }]);
	});

	it("a decimal glued to an uppercase currency prefix is a Claim, a lowercase-glued version is not", () => {
		const claims = readClaims(
			bash("cat t", "579.20 12.50"),
			reply("Total RM579.20 and USD12.50, python3.12, node22.1"),
		);
		expect(statusOf(claims)).toEqual([
			{ value: "579.20", status: "grounded" },
			{ value: "12.50", status: "grounded" },
		]);
	});

	it("slash-joined prose words are not paths", () => {
		expect(readClaims([], reply("About 3 posts/day, pass/fail, A/B"))).toEqual([
			{ value: "3", status: "guess", specificity: "small" },
		]);
	});

	it("a value matches only as a whole number, not inside a longer one", () => {
		const claims = readClaims(bash("wc -l rows", "130 rows"), reply("13 rows"));
		expect(statusOf(claims)).toEqual([{ value: "13", status: "guess" }]);
	});

	it("an integer of 1-2 digits is small, even when a tool output happens to contain it", () => {
		const ls = "-rw-r--r-- 1 root root 6259 Oct 15 23:43 /etc/caddy/Caddyfile";
		const claims = readClaims(bash("ls -l /etc/caddy", ls), reply("There are 15 sites."));
		expect(claims).toEqual([{ value: "15", status: "grounded", specificity: "small", source: expect.any(String) }]);
	});

	it("3+ digit numbers, decimals, paths and URLs are specific", () => {
		const ls = "-rw-r--r-- 1 root root 6259 Oct 15 23:43 /etc/caddy/Caddyfile";
		const claims = readClaims(
			bash("ls -l /etc/caddy", ls),
			reply("The file is 6259 bytes, /etc/caddy/Caddyfile, about 195.14 KB, see https://example.com/x."),
		);
		expect(claims.map(({ value, status, specificity }) => ({ value, status, specificity }))).toEqual([
			{ value: "https://example.com/x", status: "guess", specificity: "specific" },
			{ value: "/etc/caddy/Caddyfile", status: "grounded", specificity: "specific" },
			{ value: "6259", status: "grounded", specificity: "specific" },
			{ value: "195.14", status: "guess", specificity: "specific" },
		]);
	});

	it("a tool-output id is not part of the output, so it grounds nothing", () => {
		const claims = readClaims(bash("git status --short", "⟨t130⟩\nnothing to commit"), reply("130 files changed"));
		expect(statusOf(claims)).toEqual([{ value: "130", status: "guess" }]);
	});

	it("a reply with no values has no Claims", () => {
		expect(readClaims([user("hi")], reply("Sure, happy to help."))).toEqual([]);
	});
});

/** A bash run whose result carries a ⟨tN⟩ id, as AgentSession writes it. */
function bashT(n: number, command: string, output: string): AgentMessage[] {
	return bash(command, `⟨t${n}⟩\n${output}`);
}

describe("readClaims (cited mode)", () => {
	const taskOf = () => [user("count the untracked names"), ...bashT(7, "wc -l untracked.txt", "15 untracked.txt")];

	it("a value matching the output it cites is Grounded", () => {
		const claims = readClaims(taskOf(), reply("15 ⟨t7⟩ names are untracked."));
		expect(claims).toEqual([
			{ value: "15", status: "grounded", specificity: "small", source: expect.any(String), cited: 7 },
		]);
	});

	it("a value that differs from the output it cites is a Contradiction naming what the output shows", () => {
		const claims = readClaims(taskOf(), reply("13⟨t7⟩ names are untracked."));
		expect(claims).toEqual([
			{ value: "13", status: "contradiction", specificity: "small", cited: 7, shown: "15 untracked.txt" },
		]);
	});

	it("the same value without a Citation is a Guess", () => {
		expect(statusOf(readClaims(taskOf(), reply("13 names are untracked.")))).toEqual([
			{ value: "13", status: "guess" },
		]);
	});

	it("the marker's own digit is not a Claim", () => {
		expect(readClaims(taskOf(), reply("see ⟨t7⟩"))).toEqual([]);
	});

	it("a Citation is checked against the cited output only, not any output of the Task", () => {
		const messages = [...taskOf(), ...bashT(8, "echo", "13 other")];
		expect(statusOf(readClaims(messages, reply("13 ⟨t7⟩")))).toEqual([{ value: "13", status: "contradiction" }]);
		expect(statusOf(readClaims(messages, reply("13 ⟨t8⟩")))).toEqual([{ value: "13", status: "grounded" }]);
	});

	it("a Citation to an id outside this Task falls back to scan mode, so a value no output shows is a Guess", () => {
		expect(statusOf(readClaims(taskOf(), reply("13 ⟨t3⟩")))).toEqual([{ value: "13", status: "guess" }]);
	});

	it("a cited path is matched literally", () => {
		const messages = bashT(9, "ls", "packages/a/b.ts");
		expect(statusOf(readClaims(messages, reply("Edited packages/a/b.ts⟨t9⟩ and packages/c/d.ts⟨t9⟩.")))).toEqual([
			{ value: "packages/a/b.ts", status: "grounded" },
			{ value: "packages/c/d.ts", status: "contradiction" },
		]);
	});

	it("reads the full output the caller passes, whatever the live context pruned", () => {
		const full = `⟨t7⟩\n${"x\n".repeat(5000)}15 untracked.txt`;
		const claims = readClaims([...bash("wc", full)], reply("15 ⟨t7⟩"));
		expect(statusOf(claims)).toEqual([{ value: "15", status: "grounded" }]);
	});
});
