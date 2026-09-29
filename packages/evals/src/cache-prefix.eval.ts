import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { analyzePrefixes } from "./cache-prefix.ts";
import { createTheosesCodingAgentHarness } from "./theoses-harness.ts";

// Observational, not a pass/fail quality eval: runs tool-using turns at the production thinking level and prints where
// each provider request stops sharing a prefix with the one before it. The turn-start rows show what a new user turn
// costs the provider's prompt cache. CACHE_PREFIX_TURNS (default 2) sets the number of turns; use 10 or more to see the
// sliding window and compaction take effect. Full request bodies go to $THEOSES_EVAL_ARTIFACT_DIR.
const turns = Math.max(2, Number(process.env.CACHE_PREFIX_TURNS ?? "2"));
const payloads: unknown[] = [];

const files: Record<string, string> = {};
for (let i = 1; i <= turns; i++) {
	files[`notes-${i}.md`] =
		`Word ${i}: ${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"][i % 10]}.\n` +
		`${`Filler line for note ${i}, long enough to make the tool result a realistic size. `.repeat(12)}\n`.repeat(6);
}

const harness = createTheosesCodingAgentHarness({
	name: "cache-prefix",
	files,
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
	it(
		"reports where consecutive requests stop sharing a prefix",
		async ({ run }) => {
			const result = await run(
				Array.from({ length: turns }, (_, i) => ({
					type: "prompt" as const,
					content: `Read notes-${i + 1}.md and tell me its first word after "Word ${i + 1}:".`,
				})),
			);

			const steps = (result.output as { steps: ReturnType<typeof analyzePrefixes> }).steps;
			const rows = steps.map((s) => {
				const shared = `${s.sharedMessages}/${s.messagesAfter}`.padEnd(7);
				const pct = `${Math.round((s.charsBeforeDiff / Math.max(1, s.charsTotal)) * 100)}%`.padStart(4);
				const where = s.roleAtDiff ? `${s.roleAtDiff} [${(s.fieldsAtDiff ?? []).join(",")}]` : "(appended only)";
				return `  request ${String(s.request).padStart(2)} ${s.turnStart ? "TURN START" : "          "} shared ${shared} prefix ${pct}  other-fields-equal=${s.otherFieldsEqual}  first diff: ${where}`;
			});
			console.log(`\n[cache-prefix] ${turns} turns, ${payloads.length} requests\n${rows.join("\n")}\n`);

			const directory = process.env.THEOSES_EVAL_ARTIFACT_DIR?.trim();
			if (directory) {
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "cache-prefix-payloads.json"), JSON.stringify(payloads, null, 2));
			}
			expect(steps.length).toBeGreaterThan(2);
		},
		turns * 150_000,
	);
});
