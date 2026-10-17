/**
 * Cited Claims and Contradiction push-back (#585, ADR-0013): a reply that cites ⟨tN⟩ is checked against output tN
 * from the session log; a Contradiction gets one push at the end of the context; the run's Claim summary rides on the
 * prompt result and history is not rewritten for it.
 */
import type { AgentTool } from "theoses-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "theoses-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const listing: AgentTool = {
	name: "listing",
	label: "listing",
	description: "prints a listing",
	parameters: Type.Object({ filler: Type.Optional(Type.String()) }),
	execute: async (_id, params) => ({
		content: [
			{
				type: "text",
				text: `${(params as { filler?: string }).filler ?? ""}15 untracked.txt${(params as { filler?: string }).filler ?? ""}`,
			},
		],
		details: {},
	}),
};

describe("AgentSession cited Claims", () => {
	const harnesses: Harness[] = [];
	let sent: Context["messages"][] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		sent = [];
	});

	const respond = (message: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
		sent.push(structuredClone(context.messages));
		return message;
	};
	const callListing = (filler?: string) =>
		respond(fauxAssistantMessage([fauxToolCall("listing", filler ? { filler } : {})], { stopReason: "toolUse" }));

	async function harness(): Promise<Harness> {
		const h = await createHarness({ tools: [listing] });
		harnesses.push(h);
		return h;
	}

	it("a cited value that the output shows is Grounded and costs no push", async () => {
		const h = await harness();
		h.setResponses([callListing(), respond(fauxAssistantMessage("15 ⟨t1⟩ names are untracked."))]);

		const result = await h.session.prompt("count them");

		expect(sent).toHaveLength(2);
		expect(result?.claims?.grounded.map((c) => c.value)).toEqual(["15"]);
		expect(result?.claims?.contradictions).toEqual([]);
	});

	it("pushes back once on a Contradiction, at the end of the context, and a surviving one is in the summary", async () => {
		const h = await harness();
		h.setResponses([
			callListing(),
			respond(fauxAssistantMessage("13 ⟨t1⟩ names are untracked.")),
			respond(fauxAssistantMessage("13 ⟨t1⟩ names are untracked, really.")),
		]);

		const result = await h.session.prompt("count them");

		expect(sent).toHaveLength(3);
		// The push is appended; nothing before it is rewritten, so the earlier request is a prefix of the later one.
		expect(sent[2].slice(0, sent[1].length)).toEqual(sent[1]);
		const pushed = JSON.stringify(sent[2].slice(sent[1].length));
		expect(pushed).toContain("13");
		expect(pushed).toContain("15 untracked.txt");
		expect(result?.claims?.contradictions.map((c) => [c.value, c.cited])).toEqual([["13", 1]]);
	});

	it("a corrected reply leaves no surviving Contradiction", async () => {
		const h = await harness();
		h.setResponses([
			callListing(),
			respond(fauxAssistantMessage("13 ⟨t1⟩ names.")),
			respond(fauxAssistantMessage("15 ⟨t1⟩ names.")),
		]);

		const result = await h.session.prompt("count them");

		expect(result?.claims?.contradictions).toEqual([]);
		expect(result?.claims?.grounded.map((c) => c.value)).toEqual(["15"]);
	});

	it("an uncited value is a Guess and is never pushed on", async () => {
		const h = await harness();
		h.setResponses([callListing(), respond(fauxAssistantMessage("13 names are untracked."))]);

		const result = await h.session.prompt("count them");

		expect(sent).toHaveLength(2);
		expect(result?.claims?.guesses.map((c) => c.value)).toEqual(["13"]);
	});

	it("a reply with no Claims carries no summary", async () => {
		const h = await harness();
		h.setResponses([respond(fauxAssistantMessage("hello"))]);
		expect((await h.session.prompt("hi"))?.claims).toBeUndefined();
	});

	it("checks a citation to an output that turn-start pruning cut from the context, from the session log", async () => {
		const h = await harness();
		// The value sits in the middle of a long output: the pruned context keeps only head and tail.
		const filler = `${"a".repeat(4000)}\n`;
		h.setResponses([
			callListing(filler),
			respond(fauxAssistantMessage("ok")),
			respond(fauxAssistantMessage("15 ⟨t1⟩ names.")),
		]);

		await h.session.prompt("print it");
		const result = await h.session.prompt("how many?");

		expect(result?.claims?.grounded.map((c) => c.value)).toEqual(["15"]);
	});
});
