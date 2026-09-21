import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("../src/core/memory-consolidation.ts", () => ({
	maybeRunConsolidation: vi.fn(() => calls.push("consolidation")),
}));
vi.mock("../src/core/task-boundary-detector.ts", () => ({
	findLastUserMessageEntryId: vi.fn((branch: { id: string }[]) => branch.at(-1)?.id),
	maybeDetectTaskBoundary: vi.fn(() => calls.push("boundary")),
}));

import { maybeRunConsolidation } from "../src/core/memory-consolidation.ts";
import { maybeDetectTaskBoundary } from "../src/core/task-boundary-detector.ts";
import { settleTurn } from "../src/core/turn-settlement.ts";

function fakeSession(branch: { id: string }[]) {
	return {
		modelRuntime: { tag: "runtime" },
		sessionManager: {
			getChannelSessionKey: () => ({ channel: "telegram", channelSessionId: "42" }),
			getCwd: () => "/work",
			getBranch: () => branch,
		},
	} as never;
}

describe("settleTurn", () => {
	beforeEach(() => {
		calls.length = 0;
		vi.clearAllMocks();
	});

	it("runs consolidation then boundary detection with the session's own fields", () => {
		const session = fakeSession([{ id: "e1" }]);
		settleTurn(session, "hello");

		expect(calls).toEqual(["consolidation", "boundary"]);
		expect(maybeRunConsolidation).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/work",
				channel: "telegram",
				channelSessionId: "42",
				userMessageText: "hello",
			}),
		);
		expect(maybeDetectTaskBoundary).toHaveBeenCalledWith(
			expect.objectContaining({ userMessageEntryId: "e1", userMessageText: "hello" }),
		);
	});

	it("skips boundary detection when the branch has no user message", () => {
		settleTurn(fakeSession([]), "hello");
		expect(calls).toEqual(["consolidation"]);
	});
});
