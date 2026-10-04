import type { AssistantMessage } from "theoses-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionRun } from "../../../src/core/compaction/run.ts";
import type { OperationLoop } from "../../../src/core/operation-loop.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_operationLoop: OperationLoop;
	_compactionRun: CompactionRun;
};

function createZeroUsageAssistant(harness: Harness): AssistantMessage {
	const model = harness.getModel();
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("issue #8328 zero-usage auto-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createCompactionHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("uses the message estimate when no assistant has reported usage", async () => {
		const harness = await createCompactionHarness();
		const assistant = createZeroUsageAssistant(harness);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() - 1 },
			assistant,
		];
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const compactionRunSpy = vi.spyOn(sessionInternals._compactionRun, "run").mockResolvedValue({ kind: "skipped" });

		await sessionInternals._operationLoop.beforePrompt(assistant);

		expect(compactionRunSpy).toHaveBeenCalledOnce();
		expect(compactionRunSpy).toHaveBeenCalledWith({ reason: "threshold", willRetry: false });
	});

	it("does not compact when the zero-usage message estimate is below the threshold", async () => {
		const harness = await createCompactionHarness();
		const assistant = createZeroUsageAssistant(harness);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "short" }], timestamp: Date.now() - 1 },
			assistant,
		];
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const compactionRunSpy = vi.spyOn(sessionInternals._compactionRun, "run").mockResolvedValue({ kind: "skipped" });

		await sessionInternals._operationLoop.beforePrompt(assistant);

		expect(compactionRunSpy).not.toHaveBeenCalled();
	});
});
