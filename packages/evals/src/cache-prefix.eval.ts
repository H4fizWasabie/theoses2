import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { analyzePrefixes } from "./cache-prefix.ts";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

// Observational, not a pass/fail quality eval: runs two tool-using turns at the production thinking level and
// prints where each provider request stops sharing a prefix with the one before it. The turn-start rows show what
// a new user turn costs the provider's prompt cache. Full request bodies go to $THEOSES_EVAL_ARTIFACT_DIR.
const payloads: unknown[] = [];

const harness = createTheosesCodingAgentHarness({
	name: "cache-prefix",
	files: {
		"notes.md": "First line of the notes.\nSecond line.\nThird line.\n",
		"data.json": JSON.stringify({ items: ["alpha", "beta", "gamma", "delta"] }, null, 2),
	},
	thinkingLevel: "max",
	settings: { taskPlan: { enabled: false } },
	onPayload: (payload) => payloads.push(payload),
	output: ({ response }): JsonValue => ({
		response,
		requests: payloads.length,
		steps: JSON.parse(JSON.stringify(analyzePrefixes(payloads))),
	}),
});

describeEval("Theoses prompt-cache prefix", { harness }, (it) => {
	it("reports where consecutive requests stop sharing a prefix", async ({ run }) => {
		const result = await run([
			{
				type: "prompt",
				content:
					"Read notes.md and data.json, then tell me how many items data.json has and the first line of notes.md.",
			},
			{
				type: "prompt",
				content: "Now write those two facts to summary.txt, then read summary.txt back to confirm it.",
			},
		]);

		const steps = (result.output as { steps: ReturnType<typeof analyzePrefixes> }).steps;
		const rows = steps.map((s) => {
			const shared = `${s.sharedMessages}/${s.messagesAfter}`.padEnd(7);
			const pct = `${Math.round((s.charsBeforeDiff / Math.max(1, s.charsTotal)) * 100)}%`.padStart(4);
			const where = s.roleAtDiff ? `${s.roleAtDiff} [${(s.fieldsAtDiff ?? []).join(",")}]` : "(appended only)";
			return `  request ${String(s.request).padStart(2)} ${s.turnStart ? "TURN START" : "          "} shared ${shared} prefix ${pct}  other-fields-equal=${s.otherFieldsEqual}  first diff: ${where}`;
		});
		console.log(`\n[cache-prefix] ${payloads.length} requests\n${rows.join("\n")}\n`);

		const directory = process.env.THEOSES_EVAL_ARTIFACT_DIR?.trim();
		if (directory) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "cache-prefix-payloads.json"), JSON.stringify(payloads, null, 2));
		}
		expect(steps.length).toBeGreaterThan(2);
	});
});
