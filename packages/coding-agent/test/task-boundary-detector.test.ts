import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it } from "vitest";
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import {
	combineRelatedSignals,
	findLastUserMessageEntryId,
	findLatestTaskBoundary,
	findPreviousAssistantText,
	getTaskDescriptor,
	isMetaSummary,
	isTerseFollowUp,
	TASK_BOUNDARY_CUSTOM_TYPE,
	TASK_DESCRIPTOR_CUSTOM_TYPE,
	type TaskBoundaryData,
	type TaskDescriptorData,
} from "../src/core/task-boundary-detector.ts";

let counter = 0;
function nextId(): string {
	return `entry-${counter++}`;
}

function messageEntry(role: "user" | "assistant", text: string): SessionMessageEntry {
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: Date.now() }
			: ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage);
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function descriptorEntry(summary: string): CustomEntry<TaskDescriptorData> {
	return {
		type: "custom",
		id: nextId(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: TASK_DESCRIPTOR_CUSTOM_TYPE,
		data: { summary },
	};
}

function boundaryEntry(taskSummary: string, beforeEntryId: string): CustomEntry<TaskBoundaryData> {
	return {
		type: "custom",
		id: nextId(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: TASK_BOUNDARY_CUSTOM_TYPE,
		data: { taskSummary, beforeEntryId },
	};
}

describe("getTaskDescriptor", () => {
	it("returns '' when no task_descriptor entry exists yet", () => {
		const branch: SessionEntry[] = [messageEntry("user", "hi")];
		expect(getTaskDescriptor(branch)).toBe("");
	});

	it("returns the most recent task_descriptor summary", () => {
		const branch: SessionEntry[] = [
			messageEntry("user", "fix the bug"),
			descriptorEntry("fixing the auth bug"),
			messageEntry("user", "also add a test"),
			descriptorEntry("fixing the auth bug, now with a regression test"),
		];
		expect(getTaskDescriptor(branch)).toBe("fixing the auth bug, now with a regression test");
	});
});

describe("findLatestTaskBoundary", () => {
	it("returns undefined when no boundary has been written", () => {
		const branch: SessionEntry[] = [messageEntry("user", "hi"), descriptorEntry("chatting")];
		expect(findLatestTaskBoundary(branch)).toBeUndefined();
	});

	it("returns the most recent task_boundary entry, ignoring task_descriptor entries", () => {
		const u1 = messageEntry("user", "fix the bug");
		const u2 = messageEntry("user", "what's the weather");
		const branch: SessionEntry[] = [
			u1,
			descriptorEntry("fixing the bug"),
			boundaryEntry("asking about the weather", u2.id),
			descriptorEntry("asking about the weather"),
		];
		const found = findLatestTaskBoundary(branch);
		expect(found?.data?.taskSummary).toBe("asking about the weather");
		expect(found?.data?.beforeEntryId).toBe(u2.id);
	});
});

describe("findLastUserMessageEntryId", () => {
	it("returns undefined when there is no user message", () => {
		expect(findLastUserMessageEntryId([])).toBeUndefined();
	});

	it("returns the id of the most recent user message, skipping assistant messages and custom entries", () => {
		const u1 = messageEntry("user", "first");
		const a1 = messageEntry("assistant", "reply");
		const u2 = messageEntry("user", "second");
		const a2 = messageEntry("assistant", "reply 2");
		const branch: SessionEntry[] = [u1, a1, u2, a2, descriptorEntry("chatting")];
		expect(findLastUserMessageEntryId(branch)).toBe(u2.id);
	});
});

describe("findPreviousAssistantText", () => {
	it("returns the assistant reply immediately before the anchored user message", () => {
		const a1 = messageEntry("assistant", "Want me to open the PR?");
		const u2 = messageEntry("user", "Go");
		const branch: SessionEntry[] = [messageEntry("user", "fix it"), a1, u2];
		expect(findPreviousAssistantText(branch, u2.id)).toBe("Want me to open the PR?");
	});

	it("ignores assistant messages after the anchor", () => {
		const u1 = messageEntry("user", "hello");
		const branch: SessionEntry[] = [u1, messageEntry("assistant", "later reply")];
		expect(findPreviousAssistantText(branch, u1.id)).toBe("");
	});

	it("skips tool-call-only assistant turns with no text", () => {
		const u2 = messageEntry("user", "Check");
		const branch: SessionEntry[] = [
			messageEntry("assistant", "Deployed to staging, send a test message."),
			messageEntry("assistant", "   "),
			u2,
		];
		expect(findPreviousAssistantText(branch, u2.id)).toBe("Deployed to staging, send a test message.");
	});

	it("keeps the tail of a long reply, where the question or next step lives", () => {
		const long = `${"x".repeat(2000)}Shall I proceed?`;
		const u2 = messageEntry("user", "yes");
		const result = findPreviousAssistantText([messageEntry("assistant", long), u2], u2.id);
		expect(result.length).toBe(600);
		expect(result.endsWith("Shall I proceed?")).toBe(true);
	});
});

describe("isTerseFollowUp", () => {
	it("treats 1-2 word messages as follow-ups when there is a previous reply", () => {
		expect(isTerseFollowUp("Go", "Shall I proceed?")).toBe(true);
		expect(isTerseFollowUp("Prod shadow", "Which mode?")).toBe(true);
		expect(isTerseFollowUp("  check  ", "Deployed.")).toBe(true);
	});

	it("does not fire without a previous reply to react to", () => {
		expect(isTerseFollowUp("Go", "")).toBe(false);
	});

	it("leaves 3+ word messages to Jev, since they can start a new task", () => {
		expect(isTerseFollowUp("check my email", "Deployed.")).toBe(false);
		expect(isTerseFollowUp("Is it done?", "Deployed.")).toBe(false);
	});

	it("ignores empty input", () => {
		expect(isTerseFollowUp("   ", "Deployed.")).toBe(false);
	});
});

describe("isMetaSummary", () => {
	it("flags summaries that describe the summarizing job (real descriptors from 2026-09-19)", () => {
		expect(
			isMetaSummary(
				"The task is to refine the one-line description to reflect that the assistant must now discuss the vision.",
			),
		).toBe(true);
		expect(
			isMetaSummary(
				'The task is now to update the one-line description so that "go" refers to the user\'s decision.',
			),
		).toBe(true);
		expect(
			isMetaSummary(
				"The task has not substantially changed; the new message simply restates the merge and deploy portion.",
			),
		).toBe(true);
		expect(isMetaSummary("The new message asks about the sitemap, so the task continues.")).toBe(true);
		expect(isMetaSummary("Update the one line task description to mention the deploy.")).toBe(true);
	});

	it("keeps ordinary task descriptions, including ones about descriptions", () => {
		expect(isMetaSummary("Guide the user to enter their sitemap URL in Search Console and then submit it.")).toBe(
			false,
		);
		expect(isMetaSummary("Write the product description for the supplier catalogue and add it to the sheet.")).toBe(
			false,
		);
		expect(isMetaSummary("Fix the npm run build script that overwrites the live homepages.")).toBe(false);
		expect(isMetaSummary("The task has changed to deploying PR #34 after the user approved the merge.")).toBe(false);
	});
});

describe("combineRelatedSignals", () => {
	it("is related when the message continues the task", () => {
		expect(combineRelatedSignals({ continuesTask: 0.8, reactsToReply: 0.2, topicSwitch: 0.1 })).toBe(0.8);
	});

	it("is related when it only reacts to the last reply (terse reactions)", () => {
		expect(combineRelatedSignals({ continuesTask: 0.2, reactsToReply: 0.93, topicSwitch: 0.22 })).toBe(0.93);
	});

	it("works without a previous reply", () => {
		expect(combineRelatedSignals({ continuesTask: 0.7, topicSwitch: 0.1 })).toBe(0.7);
	});

	it("lets an explicit topic switch veto the other signals", () => {
		const combined = combineRelatedSignals({ continuesTask: 0.9, reactsToReply: 0.9, topicSwitch: 0.85 });
		expect(combined).toBeCloseTo(0.15);
		expect(combined).toBeLessThan(0.6);
	});

	it("ignores a topic-switch signal below the veto", () => {
		expect(combineRelatedSignals({ continuesTask: 0.3, reactsToReply: 0.4, topicSwitch: 0.59 })).toBe(0.4);
	});
});
