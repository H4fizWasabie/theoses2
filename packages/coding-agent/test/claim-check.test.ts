import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it } from "vitest";
import { CLAIM_CHECK_CUSTOM_TYPE, claimCheck, FINAL_REPLY_NOTE, findClaimProblem } from "../src/core/claim-check.ts";

let nextId = 0;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function reply(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

/** One assistant tool call plus its result. */
function tool(name: string, args: Record<string, unknown>, output: string, isError = false): AgentMessage[] {
	const id = `call-${nextId++}`;
	const call = reply("");
	if (call.role === "assistant") call.content = [{ type: "toolCall", id, name, arguments: args }];
	return [
		call,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError,
			timestamp: 0,
		},
	];
}

describe("findClaimProblem", () => {
	it("A: flags a failed edit that was never retried (the 2026-09-26 run.sh case)", () => {
		const problem = findClaimProblem(
			[
				user("switch run.sh to a single image"),
				...tool(
					"edit",
					{ path: "tools/run.sh" },
					"No changes applied: all 5 edits were rejected. Could not find edits[4]",
					true,
				),
				...tool("bash", { command: "sed -i '105d' tools/run.sh" }, ""),
				...tool("bash", { command: "bash tools/run.sh --dry-run" }, "[dry-run] nothing published"),
				reply("Done and verified — gate changed to exactly 1 image."),
			],
			{ cwd: process.cwd() },
		);
		expect(problem).toContain("tools/run.sh");
		expect(problem).toContain("never successfully retried");
	});

	it("A: a later successful edit to the same path resolves the failure", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "a.ts" }, "Could not find the exact text", true),
					...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
					reply("Updated a.ts."),
				],
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("A: stays quiet when the reply already reports the failure", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "src/a.ts" }, "Could not find the exact text", true),
					reply("The edit to a.ts failed: the text changed. Want me to retry?"),
				],
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("B: flags a verification claim with no command after the last change", () => {
		const problem = findClaimProblem(
			[
				user("fix it"),
				...tool("bash", { command: "npm test" }, "ok"),
				...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
				reply("Fixed and tested."),
			],
			{ cwd: process.cwd() },
		);
		expect(problem).toContain("no check command ran after your last change (a.ts)");
	});

	it("B: replays 2026-10-17 15:17: an issue body written to /tmp and posted needs no check after it", () => {
		const portfolio = "cd /home/theoses/icm-workspaces/portfolio";
		expect(
			findClaimProblem(
				[
					user("file an issue for the orphaned variant dirs"),
					...tool("write", { path: "/tmp/folio/issue2-body.md", content: "## Cleanup" }, "Wrote 1180 bytes"),
					...tool(
						"bash",
						{
							command: `${portfolio} && gh issue create --repo H4fizWasabie/portfolio --title "Cleanup" --body-file /tmp/folio/issue2-body.md --label bug 2>&1 | tail -3`,
						},
						"https://github.com/H4fizWasabie/portfolio/issues/85",
					),
					...tool(
						"bash",
						{
							command: `${portfolio} && gh issue view 85 --json number,title -q .title; echo "link: $(curl -s -o /dev/null -w '%{http_code}' https://github.com/H4fizWasabie/portfolio/issues/85)"`,
						},
						"Cleanup\nlink: 200",
					),
					reply("Filed #85 and verified it on GitHub."),
				],
				{ cwd: "/opt/theoses2/releases/current" },
			),
		).toBeUndefined();
	});

	it("B: replays 2026-10-17 14:51: a heredoc script written to /tmp and run in the same command needs no check after it", () => {
		const command = [
			"cd /tmp/folio && cat > geo.mjs <<'EOF'",
			"import { chromium } from 'playwright-core';",
			"const browser = await chromium.launch();",
			"await browser.close();",
			"EOF",
			'node geo.mjs 2>&1 | grep -v "^\\[" | tail -25',
		].join("\n");
		expect(
			findClaimProblem(
				[
					user("does the label overlap the work text on a phone?"),
					...tool("bash", { command }, "[]"),
					reply("No overlap: verified at every scroll position."),
				],
				{ cwd: "/opt/theoses2/releases/current" },
			),
		).toBeUndefined();
	});

	it("B: an edit under the session cwd still needs a check, even when that cwd is under /tmp", () => {
		const problem = findClaimProblem(
			[
				user("fix it"),
				...tool("edit", { path: "/tmp/project/a.ts" }, "Successfully replaced 1 block(s)"),
				reply("Fixed and verified."),
			],
			{ cwd: "/tmp/project" },
		);
		expect(problem).toContain("no check command ran after your last change (/tmp/project/a.ts)");
	});

	it("B: flags a verification claim when the last command failed", () => {
		const problem = findClaimProblem(
			[
				user("fix it"),
				...tool("write", { path: "a.ts" }, "Wrote a.ts"),
				...tool("bash", { command: "npm test" }, "1 failing\nCommand exited with code 1", true),
				reply("Fixed, tests pass."),
			],
			{ cwd: process.cwd() },
		);
		expect(problem).toContain("last check after your changes failed: 1 failing");
	});

	it("B: a grep with no matches after the change is not a failed check", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
					...tool("bash", { command: "npm test" }, "all passed"),
					...tool("bash", { command: "grep -n oldName src/a.ts" }, "Command exited with code 1", true),
					reply("Fixed and verified."),
				],
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("B: a plan verify item takes over the evidence check", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
					reply("Fixed and tested."),
				],
				{ plan: { covered: true }, cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("B: accepts a verification claim backed by a passing command", () => {
		expect(
			findClaimProblem(
				[
					user("fix it"),
					...tool("edit", { path: "a.ts" }, "Successfully replaced 1 block(s)"),
					...tool("bash", { command: "npm test" }, "all passed"),
					reply("Fixed and verified."),
				],
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("C: flags a done claim for a requested change with no tool calls", () => {
		expect(
			findClaimProblem([user("delete the old backup file"), reply("Done, deleted.")], { cwd: process.cwd() }),
		).toContain("no tool calls");
	});

	it("C: ignores plain conversation", () => {
		expect(
			findClaimProblem([user("how are you?"), reply("All good, done for the day.")], { cwd: process.cwd() }),
		).toBeUndefined();
	});
});

describe("claimCheck", () => {
	it("pushes back at most once per run", async () => {
		const run = [user("delete the old backup file"), reply("Done.")];
		const first = claimCheck(run, { cwd: process.cwd() });
		expect(first).toMatchObject({ role: "custom", customType: CLAIM_CHECK_CUSTOM_TYPE });
		// #389: the corrected reply replaces this one in Telegram, so it must be the full answer.
		expect(first?.content).toContain(FINAL_REPLY_NOTE);
		expect(claimCheck([...run, first as AgentMessage, reply("Done.")], { cwd: process.cwd() })).toBeUndefined();
	});
});

describe("D: Contradiction", () => {
	const t7 = (): AgentMessage[] => tool("bash", { command: "wc -l untracked.txt" }, "⟨t7⟩\n15 untracked.txt");

	it("pushes back on a value that contradicts the output it cites, naming value, id and what the output shows", () => {
		const problem = findClaimProblem([user("count them"), ...t7(), reply("13 ⟨t7⟩ names are untracked.")], {
			cwd: process.cwd(),
		});
		expect(problem).toContain("13");
		expect(problem).toContain("⟨t7⟩");
		expect(problem).toContain("15 untracked.txt");
	});

	it("is quiet for a Grounded Claim and for a Guess", () => {
		expect(
			findClaimProblem([user("count them"), ...t7(), reply("15 ⟨t7⟩ names.")], { cwd: process.cwd() }),
		).toBeUndefined();
		expect(
			findClaimProblem([user("count them"), ...t7(), reply("13 names.")], { cwd: process.cwd() }),
		).toBeUndefined();
	});

	it("checks against the Task's messages when given, so an output from before this run counts", () => {
		const run = [user("and now?"), reply("13 ⟨t7⟩ names.")];
		expect(findClaimProblem(run, { cwd: process.cwd() })).toBeUndefined();
		expect(findClaimProblem(run, { cwd: process.cwd(), task: [user("count"), ...t7(), ...run] })).toContain("15");
	});

	it("shares the one push per run with the other rules, and the push carries the final-reply note", () => {
		const run = [user("count them"), ...t7(), reply("13 ⟨t7⟩ names.")];
		const first = claimCheck(run, { cwd: process.cwd() });
		expect(first?.content).toContain(FINAL_REPLY_NOTE);
		expect(
			claimCheck([...run, first as AgentMessage, reply("13 ⟨t7⟩ names.")], { cwd: process.cwd() }),
		).toBeUndefined();
	});
});
