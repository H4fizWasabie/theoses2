import { fauxAssistantMessage } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const RETRY = { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } };
const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

function outcomes(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "operation_finished" ? [entry.outcome] : []));
}

function onFirstRetryStart(harness: Harness, run: () => void): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				unsubscribe();
				run();
				resolve();
			}
		});
	});
}

describe("AgentSession operation outcome", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(settings: typeof RETRY): Promise<Harness> {
		const created = await createHarness({ settings });
		harnesses.push(created);
		return created;
	}

	it("records one completed outcome for a turn that succeeds after a retry", async () => {
		const h = await harness(RETRY);
		h.setResponses([overloaded(), fauxAssistantMessage("recovered")]);
		await expect(h.session.prompt("hi")).resolves.toEqual({ outcome: "completed", finalError: undefined });
		expect(outcomes(h)).toEqual(["completed"]);
	});

	it("records one failed outcome with the final error once retries are exhausted", async () => {
		const h = await harness(RETRY);
		h.setResponses([overloaded(), overloaded(), overloaded()]);
		const result = await h.session.prompt("hi");
		expect(result?.outcome).toBe("failed");
		expect(result?.finalError?.message).toBe("overloaded_error");
		expect(outcomes(h)).toEqual(["failed"]);
	});

	it("leaves the turn unclosed while a retry is in flight, so a crash then reads as interrupted", async () => {
		const h = await harness(RETRY);
		h.setResponses([overloaded(), fauxAssistantMessage("recovered")]);
		let duringRetry: string[] = [];
		const sawRetry = onFirstRetryStart(h, () => {
			duringRetry = outcomes(h);
		});
		await h.session.prompt("hi");
		await sawRetry;
		expect(duringRetry).toEqual([]);
	});

	it("records aborted when stop cancels the retry backoff", async () => {
		const h = await harness({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10_000 } });
		h.setResponses([overloaded()]);
		// Next tick: auto_retry_start is emitted just before the backoff sleep starts, like a real /stop would land.
		const sawRetry = onFirstRetryStart(h, () => {
			setTimeout(() => void h.session.abort(), 0);
		});
		const result = await h.session.prompt("hi");
		await sawRetry;
		expect(result?.outcome).toBe("aborted");
		expect(outcomes(h)).toEqual(["aborted"]);
		expect(h.sessionManager.getLastOperationOutcome()).toBe("aborted");
	});
});
