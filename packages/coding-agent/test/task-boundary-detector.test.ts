import type { AgentMessage } from "theoses-agent-core";
import { describe, expect, it } from "vitest";
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import {
	findLastUserMessageEntryId,
	findLatestTaskBoundary,
	getTaskDescriptor,
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
			: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
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
