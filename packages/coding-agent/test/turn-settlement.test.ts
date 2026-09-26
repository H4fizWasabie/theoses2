import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("../src/core/task-boundary-detector.ts", () => ({
	findLastUserMessageEntryId: vi.fn((branch: { id: string }[]) => branch.at(-1)?.id),
	maybeDetectTaskBoundary: vi.fn(() => calls.push("boundary")),
}));

import { maybeDetectTaskBoundary } from "../src/core/task-boundary-detector.ts";
import { settleTurn } from "../src/core/turn-settlement.ts";

function fakeSession(branch: { id: string }[]) {
	const settle = vi.fn(() => calls.push("promotion"));
	return {
		session: {
			modelRuntime: { tag: "runtime" },
			sessionManager: {
				getChannelSessionKey: () => ({ channel: "telegram", channelSessionId: "42" }),
				getCwd: () => "/work",
				getBranch: () => branch,
			},
			memoryPromotion: { settle, promoteDropped: vi.fn(), recordSaved: vi.fn() },
		} as never,
		settle,
	};
}

describe("settleTurn", () => {
	beforeEach(() => {
		calls.length = 0;
		vi.clearAllMocks();
	});

	it("runs memory promotion's settle() then boundary detection with the session's own fields", () => {
		const { session, settle } = fakeSession([{ id: "e1" }]);
		settleTurn(session, "hello");

		expect(calls).toEqual(["promotion", "boundary"]);
		expect(settle).toHaveBeenCalledWith("hello");
		expect(maybeDetectTaskBoundary).toHaveBeenCalledWith(
			expect.objectContaining({ userMessageEntryId: "e1", userMessageText: "hello" }),
		);
	});

	it("skips boundary detection when the branch has no user message", () => {
		const { session } = fakeSession([]);
		settleTurn(session, "hello");
		expect(calls).toEqual(["promotion"]);
	});
});
