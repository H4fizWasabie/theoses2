import { describe, expect, it, vi } from "vitest";
import type { RewindPlan, RewindResult } from "../src/core/file-checkpoints.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RewindContext = {
	session: {
		isStreaming: boolean;
		getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
		previewFileRewind: (entryId: string) => RewindPlan;
		rewindFiles: (entryId: string) => RewindResult;
	};
	runtimeHost: { fork: (entryId: string) => Promise<{ cancelled: boolean; selectedText?: string }> };
	/** Picks the option at `choose` from the list it is offered. */
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	rewindTo(this: RewindContext, entryId: string): Promise<void>;
	showRewindSelector(this: RewindContext): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

const plan: RewindPlan = { restore: [{ path: "/w/a.txt", hash: "h" }], skipped: [], untraced: [] };
const result: RewindResult = { restored: ["/w/a.txt"], deleted: [], failed: [], skipped: [], untraced: [] };

function context(choose: number | "cancel", overrides: Partial<RewindContext["session"]> = {}) {
	const offered: string[][] = [];
	const spies = {
		rewindFiles: vi.fn(() => result),
		fork: vi.fn(async () => ({ cancelled: false, selectedText: "the original prompt" })),
		setText: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	const ctx: RewindContext = {
		session: {
			isStreaming: false,
			getUserMessagesForForking: () => [{ entryId: "u1", text: "hello" }],
			previewFileRewind: () => plan,
			rewindFiles: spies.rewindFiles,
			...overrides,
		},
		runtimeHost: { fork: spies.fork },
		showExtensionSelector: async (_title, options) => {
			offered.push(options);
			return choose === "cancel" ? "Cancel" : options[choose];
		},
		editor: { setText: spies.setText },
		showStatus: spies.showStatus,
		showError: spies.showError,
		ui: { requestRender: vi.fn() },
	};
	return { ctx, spies, offered };
}

describe("InteractiveMode /rewind", () => {
	it("restores the files and leaves the conversation alone", async () => {
		const { ctx, spies } = context(0);

		await prototype.rewindTo.call(ctx, "u1");

		expect(spies.rewindFiles).toHaveBeenCalledWith("u1");
		expect(spies.fork).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Restored 1, deleted 0");
		expect(spies.showError).not.toHaveBeenCalled();
	});

	it("can also fork from just before the message and put its text back in the editor", async () => {
		const { ctx, spies } = context(1);

		await prototype.rewindTo.call(ctx, "u1");

		expect(spies.rewindFiles).toHaveBeenCalledWith("u1");
		expect(spies.fork).toHaveBeenCalledWith("u1");
		expect(spies.setText).toHaveBeenCalledWith("the original prompt");
		expect(spies.showStatus).toHaveBeenCalledWith(
			"Restored 1, deleted 0; forked to a new session before that message",
		);
	});

	it("changes nothing when cancelled", async () => {
		const { ctx, spies } = context("cancel");

		await prototype.rewindTo.call(ctx, "u1");

		expect(spies.rewindFiles).not.toHaveBeenCalled();
		expect(spies.fork).not.toHaveBeenCalled();
	});

	it("reports files that could not be restored", async () => {
		const { ctx, spies } = context(0, {
			rewindFiles: () => ({ ...result, restored: [], failed: [{ path: "/w/a.txt", error: "EACCES" }] }),
		});

		await prototype.rewindTo.call(ctx, "u1");

		expect(spies.showStatus).toHaveBeenCalledWith("Restored 0, deleted 0, 1 failed (/w/a.txt)");
	});

	it("shows an error instead of throwing", async () => {
		const { ctx, spies } = context(0, {
			rewindFiles: () => {
				throw new Error("Stop the current run before rewinding files");
			},
		});

		await prototype.rewindTo.call(ctx, "u1");

		expect(spies.showError).toHaveBeenCalledWith("Stop the current run before rewinding files");
	});

	it("does not open the picker while a run is active", () => {
		const { ctx, spies } = context(0, { isStreaming: true });

		prototype.showRewindSelector.call(ctx);

		expect(spies.showStatus).toHaveBeenCalledWith("Stop the current run before rewinding");
	});

	it("says so when there is no message to rewind to", () => {
		const { ctx, spies } = context(0, { getUserMessagesForForking: () => [] });

		prototype.showRewindSelector.call(ctx);

		expect(spies.showStatus).toHaveBeenCalledWith("No messages to rewind to");
	});
});
