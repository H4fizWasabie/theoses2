import type { ThinkingLevel } from "theoses-agent-core";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

// The production model rejects thinking "off" ("Reasoning is mandatory"), and this eval runs in every tier. It checks the
// plumbing, not reasoning depth, so it defaults to "low" (max made this one-word answer take 25s); EVAL_THINKING_LEVEL overrides.
const theosesCodingAgentHarness = createTheosesCodingAgentHarness({
	name: "smoke-basic-prompt",
	noTools: "all",
	thinkingLevel: (process.env.EVAL_THINKING_LEVEL as ThinkingLevel | undefined) ?? "low",
});

describeEval("Theoses Coding Agent smoke", { harness: theosesCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.THEOSES_PROVIDER);
		expect(result.usage.model).toBe(process.env.THEOSES_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
