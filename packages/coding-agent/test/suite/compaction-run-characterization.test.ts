import { type AssistantMessage, fauxAssistantMessage } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Pins the observable sequence of one compaction run (events and extension hooks) for the manual and
 * automatic triggers, so the two paths stay in step.
 */

type AutoCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold" | "turns", willRetry: boolean) => Promise<boolean>;
};

/** `default` leaves the hook without a result, so the built-in summarizer runs. */
type BeforeCompactBehavior = "summary" | "default" | "cancel" | "wait-for-abort";

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { stopReason: "stop", timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Records every compaction hook in `log` and answers `session_before_compact` as `before` says. */
function recordingExtension(log: string[], before: BeforeCompactBehavior): InlineExtension {
	return (pi) => {
		pi.on("session_before_compact", async (event) => {
			log.push(`hook:before:${event.reason}`);
			if (before === "default") return undefined;
			if (before === "cancel") return { cancel: true };
			if (before === "wait-for-abort") {
				return await new Promise<{ cancel: true }>((resolve) => {
					event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
				});
			}
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		pi.on("session_compact", async (event) => {
			log.push(`hook:compact:${event.reason}:fromExtension=${event.fromExtension}`);
		});
		pi.on("session_compact_failed", async (event) => {
			log.push(
				`hook:failed:${event.reason}:aborted=${event.aborted}:fromExtension=${event.fromExtension}:error=${event.errorMessage ?? ""}`,
			);
		});
	};
}

function recordEvents(harness: Harness, log: string[]): void {
	harness.session.subscribe((event) => {
		if (event.type === "compaction_start") log.push(`event:start:${event.reason}`);
		if (event.type === "compaction_end") {
			log.push(
				`event:end:${event.reason}:aborted=${event.aborted}:willRetry=${event.willRetry}:error=${event.errorMessage ?? ""}`,
			);
		}
	});
}

async function setup(before: BeforeCompactBehavior): Promise<{ harness: Harness; log: string[] }> {
	const log: string[] = [];
	const harness = await createHarness({ extensionFactories: [recordingExtension(log, before)] });
	seedCompactableSession(harness);
	recordEvents(harness, log);
	return { harness, log };
}

describe("compaction run characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function open(before: BeforeCompactBehavior) {
		const result = await setup(before);
		harnesses.push(result.harness);
		return result;
	}

	it("manual success: start, hook, compact hook, end", async () => {
		const { harness, log } = await open("summary");

		await harness.session.compact();

		expect(log).toEqual([
			"event:start:manual",
			"hook:before:manual",
			"hook:compact:manual:fromExtension=true",
			"event:end:manual:aborted=false:willRetry=false:error=",
		]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("auto success: same sequence with the trigger reason", async () => {
		const { harness, log } = await open("summary");
		const internals = harness.session as unknown as AutoCompactionInternals;

		await internals._runAutoCompaction("threshold", false);

		expect(log).toEqual([
			"event:start:threshold",
			"hook:before:threshold",
			"hook:compact:threshold:fromExtension=true",
			"event:end:threshold:aborted=false:willRetry=false:error=",
		]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("manual hook cancel: rejects and reports an aborted failure", async () => {
		const { harness, log } = await open("cancel");

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(log).toEqual([
			"event:start:manual",
			"hook:before:manual",
			"event:end:manual:aborted=true:willRetry=false:error=",
			"hook:failed:manual:aborted=true:fromExtension=false:error=",
		]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("auto hook cancel: resolves false and reports an aborted failure", async () => {
		const { harness, log } = await open("cancel");
		const internals = harness.session as unknown as AutoCompactionInternals;

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(log).toEqual([
			"event:start:threshold",
			"hook:before:threshold",
			"event:end:threshold:aborted=true:willRetry=false:error=",
			"hook:failed:threshold:aborted=true:fromExtension=false:error=",
		]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("manual abortCompaction during the hook: rejects and reports an aborted failure", async () => {
		const { harness, log } = await open("wait-for-abort");

		const run = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isCompacting).toBe(true);
		harness.session.abortCompaction();

		await expect(run).rejects.toThrow("Compaction cancelled");
		expect(log).toEqual([
			"event:start:manual",
			"hook:before:manual",
			"event:end:manual:aborted=true:willRetry=false:error=",
			"hook:failed:manual:aborted=true:fromExtension=false:error=",
		]);
	});

	it("auto abortCompaction during the hook: resolves false and reports an aborted failure", async () => {
		const { harness, log } = await open("wait-for-abort");
		const internals = harness.session as unknown as AutoCompactionInternals;

		const run = internals._runAutoCompaction("threshold", false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isCompacting).toBe(true);
		harness.session.abortCompaction();

		await expect(run).resolves.toBe(false);
		expect(log).toEqual([
			"event:start:threshold",
			"hook:before:threshold",
			"event:end:threshold:aborted=true:willRetry=false:error=",
			"hook:failed:threshold:aborted=true:fromExtension=false:error=",
		]);
	});

	it("manual summarizer failure: rejects and reports Compaction failed", async () => {
		const { harness, log } = await open("default");
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};

		await expect(harness.session.compact()).rejects.toThrow("summary generator blew up");

		expect(log).toEqual([
			"event:start:manual",
			"hook:before:manual",
			expect.stringMatching(
				/^event:end:manual:aborted=false:willRetry=false:error=Compaction failed: .*summary generator blew up/,
			),
			expect.stringMatching(/^hook:failed:manual:aborted=false:fromExtension=false:error=Compaction failed: /),
		]);
	});

	it("auto summarizer failure: resolves false and reports Auto-compaction failed", async () => {
		const { harness, log } = await open("default");
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const internals = harness.session as unknown as AutoCompactionInternals;

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(log).toEqual([
			"event:start:threshold",
			"hook:before:threshold",
			"event:end:threshold:aborted=false:willRetry=false:error=Auto-compaction failed: summary generator blew up",
			"hook:failed:threshold:aborted=false:fromExtension=false:error=Auto-compaction failed: summary generator blew up",
		]);
	});

	it("manual with nothing to compact: rejects and reports Compaction failed", async () => {
		const log: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		recordEvents(harness, log);

		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact");

		expect(log).toEqual([
			"event:start:manual",
			"event:end:manual:aborted=false:willRetry=false:error=Compaction failed: Nothing to compact (session too small)",
		]);
	});

	it("auto with nothing to compact: resolves false and stays silent", async () => {
		const log: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		recordEvents(harness, log);
		const internals = harness.session as unknown as AutoCompactionInternals;

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(log).toEqual([]);
	});

	it("auto run is idle when compaction_end listeners run, on success and on failure", async () => {
		const success = await open("summary");
		const failure = await open("default");
		failure.harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const seen: Array<{ label: string; isCompacting: boolean }> = [];
		for (const [label, { harness }] of [
			["success", success],
			["failure", failure],
		] as const) {
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end") seen.push({ label, isCompacting: harness.session.isCompacting });
			});
			await (harness.session as unknown as AutoCompactionInternals)._runAutoCompaction("threshold", false);
		}

		expect(seen).toEqual([
			{ label: "success", isCompacting: false },
			{ label: "failure", isCompacting: false },
		]);
	});

	it("manual run blocks prompt() while it runs", async () => {
		const { harness } = await open("wait-for-abort");

		const run = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(harness.session.prompt("during compaction")).rejects.toThrow(
			"Cannot submit a prompt while compaction is in progress",
		);

		harness.session.abortCompaction();
		await expect(run).rejects.toThrow("Compaction cancelled");
	});
});
