import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createTheosesCodingAgentHarness, type TheosesCodingAgentInput } from "./theoses-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

// Does a more concrete efficiency instruction make the model send independent tool calls together? Every extra
// message is a full round trip. In production GLM 5.3 flash puts 2+ calls in only 6% of its tool messages, against
// 26-53% for other models, although the default prompt already asks for batching. Each task needs several
// independent reads; the judge checks the answer stays correct, the report shows tokens and latency, and each run
// logs how its tool calls were grouped.
const WORDS = [
	"alpha",
	"birch",
	"cobalt",
	"dune",
	"ember",
	"fjord",
	"garnet",
	"harbor",
	"indigo",
	"juniper",
	"kelp",
	"lumen",
];
const FILES_PER_TASK = 5;

type Task = { id: string; files: Record<string, string>; prompt: string; expected: string[] };

function task(index: number): Task {
	const files: Record<string, string> = {};
	const expected: string[] = [];
	for (let k = 1; k <= FILES_PER_TASK; k++) {
		const word = WORDS[(index * FILES_PER_TASK + k) % WORDS.length];
		expected.push(word);
		files[`part${k}.txt`] =
			`${word} is the first word of part ${k}.\n${"Padding line to make the file a realistic size. ".repeat(8)}\n`;
	}
	return {
		id: `read-${FILES_PER_TASK}-files-${index}`,
		files,
		prompt: `Read part1.txt through part${FILES_PER_TASK}.txt in this directory and give me the first word of each, one per line, in order.`,
		expected,
	};
}

const tasks = [0, 1, 2].map(task);

const STRONGER_EFFICIENCY = `<efficiency>
Every tool call sent in its own message costs a full round trip. Send every call you already know you need in ONE message. To read five files, make five read calls in the same message; never read one, wait, then read the next. Before each tool call ask: is there another call I already know I need? If so, put it in this same message. Sequence calls only when one needs an earlier result. Combine related shell steps with &&. Read a file whole instead of in small slices. A bare greeting or check-in needs a reply, not an investigation.
</efficiency>`;

function withStrongerEfficiency(prompt: string): string {
	if (!/<efficiency>[\s\S]*?<\/efficiency>/.test(prompt)) throw new Error("Default prompt has no <efficiency> block.");
	return prompt.replace(/<efficiency>[\s\S]*?<\/efficiency>/, STRONGER_EFFICIENCY);
}

type Output = { response: string; toolMessages: number; multiCallMessages: number; requests: number };

function harnessFor(name: string, files: Record<string, string>, strong: boolean) {
	return createTheosesCodingAgentHarness({
		name,
		files,
		thinkingLevel: "max",
		// Only `read`: with bash available the model collapses the task into one `cat` command and never batches.
		tools: ["read"],
		settings: { taskPlan: { enabled: false } },
		...(strong ? { transformSystemPrompt: withStrongerEfficiency } : {}),
		output: ({ response, session }): Output => {
			const assistants = session.messages.filter((m) => m.role === "assistant");
			const callCounts = assistants.map((m) => m.content.filter((part) => part.type === "toolCall").length);
			const out: Output = {
				response,
				requests: assistants.length,
				toolMessages: callCounts.filter((n) => n > 0).length,
				multiCallMessages: callCounts.filter((n) => n > 1).length,
			};
			console.log(
				`[batching] ${name} requests=${out.requests} toolMessages=${out.toolMessages} multiCall=${out.multiCallMessages}`,
			);
			return out;
		},
	});
}

/** Scores 1 when every expected word appears in the answer, in order. */
function answersCorrectly(expected: string[]) {
	return createJudge<TheosesCodingAgentInput, Output>("AnswersCorrectly", ({ output }) => {
		const text = output.response.toLowerCase();
		let from = 0;
		for (const word of expected) {
			const at = text.indexOf(word, from);
			if (at < 0) return { score: 0 };
			from = at + word.length;
		}
		return { score: 1 };
	});
}

for (const t of tasks) {
	const harnessTable = evalHarnessTable(`batching ${t.id}`, {
		baseline: harnessFor("default-prompt", t.files, false),
		candidate: harnessFor("stronger-batching-prompt", t.files, true),
		repetitions: 3,
	});
	describe.for(harnessTable)(`${t.id} $name repetition $repetition`, ({ harness }) => {
		describeEval(
			`Batching ${t.id}`,
			{ harness, judges: [answersCorrectly(t.expected)], judgeThreshold: null },
			(it) => {
				it("reads the files", async ({ run }) => {
					await run(t.prompt);
				});
			},
		);
	});
}
