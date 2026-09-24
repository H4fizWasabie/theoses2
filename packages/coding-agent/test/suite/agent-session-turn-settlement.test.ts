import { fauxAssistantMessage } from "theoses-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

vi.mock("../../src/core/turn-settlement.ts", () => ({ settleTurn: vi.fn() }));

import { settleTurn } from "../../src/core/turn-settlement.ts";

const CHANNEL = { sessionOptions: { channel: "telegram", channelSessionId: "1" } } satisfies HarnessOptions;

describe("AgentSession Turn Settlement", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.mocked(settleTurn).mockClear();
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(options: HarnessOptions = CHANNEL): Promise<Harness> {
		const created = await createHarness(options);
		harnesses.push(created);
		return created;
	}

	it("settles a completed Channel Session turn with the prompt text", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("fix the bug");
		expect(settleTurn).toHaveBeenCalledTimes(1);
		expect(settleTurn).toHaveBeenCalledWith(h.session, "fix the bug");
	});

	it("passes settlementText instead of the prompt text when given", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("[attachment note]", { settlementText: "" });
		expect(settleTurn).toHaveBeenCalledWith(h.session, "");
	});

	it("does not settle a CLI session", async () => {
		const h = await harness({});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("hi");
		expect(settleTurn).not.toHaveBeenCalled();
	});

	it("does not settle a failed turn", async () => {
		const h = await harness({ ...CHANNEL, settings: { retry: { enabled: false } } });
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		await h.session.prompt("hi");
		expect(settleTurn).not.toHaveBeenCalled();
	});

	it("does not settle an aborted turn", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		await h.session.prompt("hi");
		expect(settleTurn).not.toHaveBeenCalled();
	});

	it("settles once, after the retry succeeds", async () => {
		const h = await harness({ ...CHANNEL, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await h.session.prompt("hi");
		expect(h.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(settleTurn).toHaveBeenCalledTimes(1);
	});
});
