import type { ChannelSession, PromptResult } from "theoses-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnQueue, type PreparedTurn } from "../src/turn-queue.ts";

/** A fake Channel Session whose turns stay running until `end` resolves them, or `stop` aborts them. */
function fakeSession(runningTool?: string) {
	const ends: Array<(result?: PromptResult) => void> = [];
	const session = {
		submit: vi.fn(
			() =>
				new Promise<PromptResult | undefined>((resolve) => {
					ends.push(resolve);
				}),
		),
		stop: vi.fn(async () => {
			ends.shift()?.({ outcome: "aborted" });
			return { wasRunning: true, runningTool };
		}),
		end: (result?: PromptResult) => ends.shift()?.(result),
	};
	return session;
}

function harness() {
	const events: string[] = [];
	const queue = createTurnQueue({
		onBusy: (chat) => events.push(`busy:${chat}`),
		onIdle: (chat) => events.push(`idle:${chat}`),
		resumeDelayMs: 60_000,
	});
	const session = fakeSession("bash");
	/** A turn named `name` that submits to `session` once `ready` settles. */
	const turn = (name: string, ready?: Promise<void>) =>
		vi.fn(async (_signal: AbortSignal, resume: boolean): Promise<PreparedTurn> => {
			await ready;
			events.push(`${resume ? "resume" : "run"}:${name}`);
			return {
				session: session as unknown as ChannelSession,
				input: { text: name },
				finish: async (result, { resumeInMs }) => {
					events.push(`finish:${name}:${result?.outcome}${resumeInMs ? `:resume in ${resumeInMs}` : ""}`);
				},
			};
		});
	return { queue, session, events, turn };
}

const failed: PromptResult = { outcome: "failed", finalError: { message: "timeout", provider: "p", model: "m" } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createTurnQueue", () => {
	it("runs a chat's turns in order, and other chats independently", async () => {
		const { queue, session, events, turn } = harness();
		queue.submit("a", turn("a1"));
		queue.submit("a", turn("a2"));
		queue.submit("b", turn("b1"));
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a", "busy:b", "run:a1", "run:b1"]);

		session.end({ outcome: "completed" });
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(0);
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual([
			"busy:a",
			"busy:b",
			"run:a1",
			"run:b1",
			"finish:a1:completed",
			"finish:b1:completed",
			"idle:b",
			"run:a2",
			"finish:a2:completed",
			"idle:a",
		]);
	});

	it("stays busy until the last turn has finished rendering", async () => {
		const { queue, session, events } = harness();
		let releaseFinish: () => void = () => {};
		queue.submit("a", async () => ({
			session: session as unknown as ChannelSession,
			input: { text: "x" },
			finish: () =>
				new Promise<void>((resolve) => {
					releaseFinish = resolve;
				}),
		}));
		await vi.advanceTimersByTimeAsync(0);
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a"]);
		releaseFinish();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a", "idle:a"]);
	});

	it("halts a turn that is still preparing, instead of reporting nothing queued", async () => {
		const { queue, session, events, turn } = harness();
		let finishDownload: () => void = () => {};
		const download = new Promise<void>((resolve) => {
			finishDownload = resolve;
		});
		queue.submit("a", turn("photo", download));
		await vi.advanceTimersByTimeAsync(0);

		expect(await queue.stop("a")).toEqual({ kind: "halted", runningTool: undefined, skippedQueued: false });
		finishDownload();
		await vi.advanceTimersByTimeAsync(0);

		expect(session.submit).not.toHaveBeenCalled();
		expect(events).toEqual(["busy:a", "run:photo", "idle:a"]);
	});

	it("halts the running turn and skips the next queued one", async () => {
		const { queue, session, events, turn } = harness();
		queue.submit("a", turn("first"));
		queue.submit("a", turn("second"));
		queue.submit("a", turn("third"));
		await vi.advanceTimersByTimeAsync(0);

		expect(await queue.stop("a")).toEqual({ kind: "halted", runningTool: "bash", skippedQueued: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(session.stop).toHaveBeenCalledTimes(1);
		expect(events).toContain("finish:first:aborted");
		expect(events).not.toContain("run:second");
		expect(events.at(-1)).toBe("run:third");
	});

	it("skips a queued turn when the one ahead is only finishing", async () => {
		const { queue, session, events, turn } = harness();
		let releaseFinish: () => void = () => {};
		queue.submit("a", async () => ({
			session: session as unknown as ChannelSession,
			input: { text: "x" },
			finish: () =>
				new Promise<void>((resolve) => {
					releaseFinish = resolve;
				}),
		}));
		queue.submit("a", turn("queued"));
		await vi.advanceTimersByTimeAsync(0);
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(0);

		expect(await queue.stop("a")).toEqual({ kind: "skippedQueued" });
		expect(session.stop).not.toHaveBeenCalled();
		releaseFinish();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a", "idle:a"]);
	});

	it("reports nothing running when the chat is idle", async () => {
		const { queue } = harness();
		expect(await queue.stop("a")).toEqual({ kind: "idle" });
	});

	it("resumes a failed turn once, through the same preparation", async () => {
		const { queue, session, events, turn } = harness();
		const prepare = turn("task");
		queue.submit("a", prepare);
		await vi.advanceTimersByTimeAsync(0);
		session.end(failed);
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a", "run:task", "finish:task:failed:resume in 60000", "idle:a"]);

		await vi.advanceTimersByTimeAsync(60_000);
		session.end(failed);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(events.slice(4)).toEqual(["busy:a", "resume:task", "finish:task:failed", "idle:a"]);
	});

	it("cancels a pending resume on a new turn or /stop", async () => {
		const { queue, session, turn } = harness();
		const prepare = turn("task");
		queue.submit("a", prepare);
		await vi.advanceTimersByTimeAsync(0);
		session.end(failed);
		await vi.advanceTimersByTimeAsync(0);
		expect(await queue.stop("a")).toEqual({ kind: "cancelledResume" });

		queue.submit("a", prepare);
		await vi.advanceTimersByTimeAsync(0);
		session.end(failed);
		await vi.advanceTimersByTimeAsync(0);
		queue.submit("a", turn("proceed"));
		await vi.advanceTimersByTimeAsync(0);
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	it("keeps going after a turn throws", async () => {
		const { queue, session, events, turn } = harness();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		queue.submit("a", async () => {
			throw new Error("download failed");
		});
		queue.submit("a", turn("next"));
		await vi.advanceTimersByTimeAsync(0);
		session.end({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["busy:a", "run:next", "finish:next:completed", "idle:a"]);
		expect(errorSpy).toHaveBeenCalledWith("Telegram turn failed:", "download failed");
		errorSpy.mockRestore();
	});
});
