import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONSOLIDATION_TURN_CEILING,
	capTranscript,
	MAX_TRANSCRIPT_CHARS,
	shouldTriggerConsolidation,
} from "../src/core/memory-consolidation.ts";

describe("shouldTriggerConsolidation", () => {
	const originalFetch = global.fetch;
	const originalApiKey = process.env.OPENROUTER_API_KEY;

	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key";
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = originalApiKey;
	});

	function mockJevNoul(noul: number | undefined): void {
		global.fetch = vi.fn(async () =>
			noul === undefined
				? new Response("boom", { status: 500 })
				: new Response(JSON.stringify({ answers: { answer: { type: "noul", noul } } }), { status: 200 }),
		) as unknown as typeof fetch;
	}

	it("fires when Jev reads the message as a completion signal", async () => {
		mockJevNoul(0.95);
		expect(await shouldTriggerConsolidation("Thanks a lot for that!", 3)).toBe(true);
	});

	it("does not fire when Jev reads the message as ordinary, under the turn ceiling", async () => {
		mockJevNoul(0.05);
		expect(await shouldTriggerConsolidation("what's the weather like", 5)).toBe(false);
	});

	it("does not fire when the Jev call fails, under the turn ceiling", async () => {
		mockJevNoul(undefined);
		expect(await shouldTriggerConsolidation("continue", 5)).toBe(false);
	});

	it("fires once the turn ceiling is reached, bypassing Jev entirely", async () => {
		// Below the ceiling, the (failing) Jev call is still made and its failure means "don't
		// trigger". At/above the ceiling, the ceiling check short-circuits before Jev is ever
		// called, so it fires even though a Jev call here would fail.
		mockJevNoul(undefined);
		expect(await shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING - 1)).toBe(false);
		expect(await shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING)).toBe(true);
	});
});

describe("capTranscript (issue #177)", () => {
	it("leaves a short transcript untouched", () => {
		expect(capTranscript("short")).toBe("short");
	});

	it("keeps only the tail once the transcript exceeds the cap", () => {
		const text = "x".repeat(MAX_TRANSCRIPT_CHARS + 500);
		const capped = capTranscript(text);
		expect(capped.length).toBe(MAX_TRANSCRIPT_CHARS);
		expect(text.endsWith(capped)).toBe(true);
	});
});
