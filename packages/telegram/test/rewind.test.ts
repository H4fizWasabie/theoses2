import type { ChannelSession, RewindPoint } from "theoses-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { rewindReply } from "../src/rewind.ts";

function fakeSession(points: RewindPoint[], running = false) {
	const rewind = vi.fn(() => ({ restored: ["/w/a"], deleted: [], failed: [], skipped: [], untraced: [] }));
	const session = {
		isRunning: running,
		rewindPoints: vi.fn(() => points),
		previewRewind: vi.fn(() => "Restore 1 file to how they were before."),
		rewind,
	} as unknown as ChannelSession;
	return { session, rewind };
}

const points = [
	{ entryId: "e2", text: "make b" },
	{ entryId: "e1", text: "change a" },
];

describe("/rewind reply", () => {
	it("lists the turns that changed files, newest first, numbered", () => {
		const { session } = fakeSession(points);
		expect(rewindReply(session, "")).toBe(
			'Files changed in these turns (newest first):\n1. "make b"\n2. "change a"\nPreview one with /rewind <number>.',
		);
	});

	it("says so when no turn changed files", () => {
		expect(rewindReply(fakeSession([]).session, "")).toBe("No turn has changed files yet.");
	});

	it("previews a turn and how to confirm, without changing anything", () => {
		const { session, rewind } = fakeSession(points);
		expect(rewindReply(session, "2")).toBe(
			'Rewind files to before "change a"?\nRestore 1 file to how they were before.\nThe conversation stays as it is. Confirm with /rewind 2 yes.',
		);
		expect(rewind).not.toHaveBeenCalled();
	});

	it("puts the files back on confirmation", () => {
		const { session, rewind } = fakeSession(points);
		expect(rewindReply(session, "2 yes")).toBe('Rewound files to before "change a".\nRestored 1 file.');
		expect(rewind).toHaveBeenCalledWith("e1");
	});

	it("refuses while a turn is running, before touching anything", () => {
		const { session, rewind } = fakeSession(points, true);
		expect(rewindReply(session, "1 yes")).toBe("A turn is running. /stop it first, then rewind.");
		expect(rewind).not.toHaveBeenCalled();
	});

	it.each(["0", "3", "x", "1 maybe"])("rejects %j", (args) => {
		expect(rewindReply(fakeSession(points).session, args)).toContain("Send /rewind to see the numbers");
	});
});
