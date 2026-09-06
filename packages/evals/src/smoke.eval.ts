import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

const theosesCodingAgentHarness = createTheosesCodingAgentHarness({ noTools: "all" });

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
