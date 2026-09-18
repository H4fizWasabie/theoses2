import { describe, expect, it, vi } from "vitest";
import { classifyUrgency, resolveIntentRouterMode, urgentIntakeNotice } from "../src/core/intent-router.ts";

type AskNoul = (state: Record<string, string>, instructions: string) => Promise<number | undefined>;

function stubAskNoul(probability: number | undefined) {
	return vi.fn<AskNoul>(async () => probability);
}

describe("resolveIntentRouterMode", () => {
	it("defaults to off", () => {
		expect(resolveIntentRouterMode()).toBe("off");
	});

	it("reads THEOSES_INTENT_ROUTER, accepting unknown values as off", () => {
		process.env.THEOSES_INTENT_ROUTER = "shadow";
		expect(resolveIntentRouterMode()).toBe("shadow");
		process.env.THEOSES_INTENT_ROUTER = "ON";
		expect(resolveIntentRouterMode()).toBe("on");
		process.env.THEOSES_INTENT_ROUTER = "banana";
		expect(resolveIntentRouterMode()).toBe("off");
	});
});

describe("classifyUrgency", () => {
	it("never calls Jev when mode is off", async () => {
		const askNoul = stubAskNoul(0.99);
		const verdict = await classifyUrgency("the server is down", { mode: "off", askNoul });
		expect(verdict).toEqual({ mode: "off", isUrgent: false });
		expect(askNoul).not.toHaveBeenCalled();
	});

	it("returns isUrgent true at or above the threshold in on mode", async () => {
		const verdict = await classifyUrgency("prod is down, help", { mode: "on", askNoul: stubAskNoul(0.9) });
		expect(verdict.isUrgent).toBe(true);
		expect(verdict.probability).toBe(0.9);
	});

	it("returns isUrgent false below the threshold", async () => {
		const verdict = await classifyUrgency("haha good one", { mode: "shadow", askNoul: stubAskNoul(0.2) });
		expect(verdict.isUrgent).toBe(false);
		expect(verdict.mode).toBe("shadow");
	});

	it("threshold boundary: exactly 0.85 counts as urgent", async () => {
		const verdict = await classifyUrgency("urgent-ish", { mode: "on", askNoul: stubAskNoul(0.85) });
		expect(verdict.isUrgent).toBe(true);
	});

	it("skips empty/whitespace-only messages without calling Jev", async () => {
		const askNoul = stubAskNoul(0.9);
		const verdict = await classifyUrgency("   ", { mode: "on", askNoul });
		expect(verdict).toEqual({ mode: "on", isUrgent: false });
		expect(askNoul).not.toHaveBeenCalled();
	});

	it("treats a Jev failure (undefined) as not urgent, in both modes", async () => {
		for (const mode of ["shadow", "on"] as const) {
			const verdict = await classifyUrgency("something happened", { mode, askNoul: stubAskNoul(undefined) });
			expect(verdict.isUrgent).toBe(false);
			expect(verdict.probability).toBeUndefined();
		}
	});

	it("passes a truncated message to Jev", async () => {
		const askNoul = stubAskNoul(0.1);
		const long = "x".repeat(5000);
		await classifyUrgency(long, { mode: "shadow", askNoul });
		expect(askNoul.mock.calls[0]?.[0]).toEqual({ message: "x".repeat(2000) });
	});
});

describe("urgentIntakeNotice", () => {
	it("produces a single-line provenance notice", () => {
		const notice = urgentIntakeNotice();
		expect(notice).toMatch(/^\[intake:/);
		expect(notice).not.toContain("\n");
	});
});
