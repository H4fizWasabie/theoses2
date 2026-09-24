import { describe, expect, it, vi } from "vitest";
import { createTurnQueue } from "../src/turn-queue.ts";

describe("createTurnQueue", () => {
	it("chains turns for the same chat and lets different chats run independently", async () => {
		const turnQueue = createTurnQueue();
		const order: string[] = [];
		let releaseFirst: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		turnQueue.enqueue("chat-1", 1, async () => {
			await first;
			order.push("chat-1:1");
		});
		const chat1Second = turnQueue.enqueue("chat-1", 2, async () => {
			order.push("chat-1:2");
		});
		const chat2First = turnQueue.enqueue("chat-2", 1, async () => {
			order.push("chat-2:1");
		});

		await chat2First;
		expect(order).toEqual(["chat-2:1"]);

		releaseFirst();
		await chat1Second;
		expect(order).toEqual(["chat-2:1", "chat-1:1", "chat-1:2"]);
	});

	it("tracks queue depth across the whole turn, not just while a job is running", () => {
		const turnQueue = createTurnQueue();
		expect(turnQueue.queueDepth("chat")).toBe(0);
		turnQueue.trackDepth("chat");
		turnQueue.trackDepth("chat");
		expect(turnQueue.queueDepth("chat")).toBe(2);
		turnQueue.untrackDepth("chat");
		expect(turnQueue.queueDepth("chat")).toBe(1);
		turnQueue.untrackDepth("chat");
		expect(turnQueue.queueDepth("chat")).toBe(0);
	});

	it("reports the head of the queue and lets a stop request skip exactly that turn", async () => {
		const turnQueue = createTurnQueue();
		const ran: number[] = [];
		turnQueue.enqueue("chat", 1, async () => {
			turnQueue.dequeue("chat", 1);
			if (turnQueue.consumeStopRequest("chat", 1)) return;
			ran.push(1);
		});
		expect(turnQueue.nextQueuedMessageId("chat")).toBe(1);

		turnQueue.requestStop("chat", 1);
		const second = turnQueue.enqueue("chat", 2, async () => {
			turnQueue.dequeue("chat", 2);
			if (turnQueue.consumeStopRequest("chat", 2)) return;
			ran.push(2);
		});
		await second;

		expect(ran).toEqual([2]);
	});

	it("consumeStopRequest only matches the message id it was requested for", async () => {
		const turnQueue = createTurnQueue();
		turnQueue.requestStop("chat", 1);
		expect(turnQueue.consumeStopRequest("chat", 2)).toBe(false);
		expect(turnQueue.consumeStopRequest("chat", 1)).toBe(true);
		// Consuming clears it - a second consume for the same id finds nothing.
		expect(turnQueue.consumeStopRequest("chat", 1)).toBe(false);
	});

	it("tracks the running tool per chat, independently", () => {
		const turnQueue = createTurnQueue();
		expect(turnQueue.getRunningTool("chat-1")).toBeUndefined();
		turnQueue.setRunningTool("chat-1", "bash");
		turnQueue.setRunningTool("chat-2", "read");
		expect(turnQueue.getRunningTool("chat-1")).toBe("bash");
		expect(turnQueue.getRunningTool("chat-2")).toBe("read");
		turnQueue.setRunningTool("chat-1", undefined);
		expect(turnQueue.getRunningTool("chat-1")).toBeUndefined();
	});

	it("marks and consumes halted-by-stop once", () => {
		const turnQueue = createTurnQueue();
		expect(turnQueue.consumeHaltedByStop("chat")).toBe(false);
		turnQueue.markHaltedByStop("chat");
		expect(turnQueue.consumeHaltedByStop("chat")).toBe(true);
		expect(turnQueue.consumeHaltedByStop("chat")).toBe(false);
	});

	it("schedules and cancels an auto-resume", () => {
		vi.useFakeTimers();
		try {
			const turnQueue = createTurnQueue();
			const run = vi.fn();
			turnQueue.scheduleAutoResume("chat", run, 1000);

			expect(turnQueue.cancelAutoResume("chat")).toBe(true);
			vi.advanceTimersByTime(2000);
			expect(run).not.toHaveBeenCalled();
			expect(turnQueue.cancelAutoResume("chat")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs a scheduled auto-resume that isn't cancelled", () => {
		vi.useFakeTimers();
		try {
			const turnQueue = createTurnQueue();
			const run = vi.fn();
			turnQueue.scheduleAutoResume("chat", run, 1000);
			vi.advanceTimersByTime(1000);
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a later scheduleAutoResume replaces (clears) an earlier one for the same chat (issue #365)", () => {
		vi.useFakeTimers();
		try {
			const turnQueue = createTurnQueue();
			const first = vi.fn();
			const second = vi.fn();
			turnQueue.scheduleAutoResume("chat", first, 1000);
			turnQueue.scheduleAutoResume("chat", second, 1000);
			vi.advanceTimersByTime(1000);
			expect(first).not.toHaveBeenCalled();
			expect(second).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
