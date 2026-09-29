import type { AgentMessage } from "theoses-agent-core";
import { StringEnum } from "theoses-ai";
import { Text } from "theoses-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { applyPlanAction, formatPlan, MAX_PLAN_ITEMS, type TaskPlan } from "../task-plan.ts";

const taskPlanSchema = Type.Object({
	action: StringEnum(["create", "add", "update", "abandon", "show"] as const, {
		description:
			"create: start a plan (needs goal and verify). add: append steps (needs `verify` if every verify item is already closed, so new steps don't ship unverified). update: set one item's status/note. abandon: drop the plan with a reason. show: print it.",
	}),
	kind: Type.Optional(
		StringEnum(["change", "fix"] as const, {
			description:
				'create only. "fix" when correcting something broken (a bug, a failed run, an error report); it adds root-cause, siblings and fix-scope items. Otherwise "change".',
		}),
	),
	goal: Type.Optional(Type.String({ description: "create only. What the whole task achieves, in one line." })),
	items: Type.Optional(
		Type.Array(Type.String(), {
			description: `create/add. One entry per piece of the change (each file, stage or config it touches). At most ${MAX_PLAN_ITEMS} items in total.`,
		}),
	),
	verify: Type.Optional(
		Type.String({
			description:
				"create: the command or check that will prove the change works end to end (it must run the changed code, not just parse it). add: required only when every verify item is already closed — the check that will prove the newly added steps; ignored if a verify item is still open (the open one already covers them).",
		}),
	),
	id: Type.Optional(Type.Number({ description: "update only. Item id." })),
	status: Type.Optional(
		StringEnum(["done", "deferred", "open"] as const, {
			description:
				"update only. deferred = cannot be done now; needs a note with the reason. A verify item only closes after a check command passed since the last file change.",
		}),
	),
	note: Type.Optional(
		Type.String({
			description:
				"update only. Evidence or outcome. Required for deferred, and for root-cause/siblings/fix-scope items (their content goes here).",
		}),
	),
	reason: Type.Optional(Type.String({ description: "abandon only. Why the plan no longer applies." })),
});

export type TaskPlanToolInput = Static<typeof taskPlanSchema>;

export interface TaskPlanToolDeps {
	get: () => TaskPlan | undefined;
	set: (plan: TaskPlan) => void;
	/** Messages of the current run so far, for verify evidence and the request text. */
	runMessages: () => AgentMessage[];
}

function requestText(messages: AgentMessage[]): string {
	const user = messages.find((m) => m.role === "user");
	if (!user || user.role !== "user") return "";
	return typeof user.content === "string"
		? user.content
		: user.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export function createTaskPlanToolDefinition(deps: TaskPlanToolDeps): ToolDefinition<typeof taskPlanSchema> {
	return {
		name: "task_plan",
		label: "task_plan",
		description:
			"An optional plan for the current task: every piece of the change plus the check that proves it. Use it when it helps you keep track; nothing requires it.",
		promptSnippet: "Optionally plan a multi-part change and prove each part before calling it done",
		promptGuidelines: [
			"Use task_plan when a task touches several files, stages or configs, or when a fix might have siblings that share its cause. Skip it for small single-step changes and for questions. If you use it, list every piece of the change plus a verify check that runs the changed code, and add items as you discover more work.",
			'For anything broken (a bug, an error, a failed run) where you do plan, use kind "fix": find the root cause rather than patching where it failed, search for every other place that relies on the same assumption, and fix or rule out each one.',
			"If you plan, close each item with task_plan update as you finish it. Say plainly what you deferred or could not verify; never report a task done while part of it is open.",
		],
		parameters: taskPlanSchema,
		execute: async (_toolCallId, input: TaskPlanToolInput) => {
			const runMessages = deps.runMessages();
			const result = applyPlanAction(deps.get(), input, { runMessages, request: requestText(runMessages) });
			if (result.error || !result.plan) throw new Error(result.error ?? "No task plan.");
			if (input.action !== "show") deps.set(result.plan);
			return { content: [{ type: "text", text: formatPlan(result.plan) }], details: undefined };
		},
		renderCall: (args, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`task_plan ${args.action ?? ""}`)), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0),
	};
}
