import { describe, expect, it } from "vitest";
import { CONSOLIDATION_TURN_CEILING, shouldTriggerConsolidation } from "../src/core/memory-consolidation.ts";

describe("shouldTriggerConsolidation", () => {
	it("fires on a completion keyword, case-insensitive, anywhere in the message", () => {
		expect(shouldTriggerConsolidation("Thanks a lot for that!", 3)).toBe(true);
		expect(shouldTriggerConsolidation("GREAT JOB on the deploy", 1)).toBe(true);
	});

	it("does not fire on an ordinary message under the turn ceiling", () => {
		expect(shouldTriggerConsolidation("what's the weather like", 5)).toBe(false);
	});

	it("fires once the turn ceiling is reached even without a keyword", () => {
		expect(shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING - 1)).toBe(false);
		expect(shouldTriggerConsolidation("continue", CONSOLIDATION_TURN_CEILING)).toBe(true);
	});
});
