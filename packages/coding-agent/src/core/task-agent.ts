/**
 * The `task` tool: a sub-agent that does one self-contained piece of work in its own context and returns only a
 * summary. Its reads, searches, failed attempts and command output never enter the parent's context, which is paid for
 * on every later turn; the parent gets a few lines saying what changed, how it was checked, and what is left.
 *
 * Unlike `explore` (read-only, a cheap background model), a task can edit files and run commands, so it runs on the
 * parent's own model and thinking level, with the parent's tool settings (shell prefix and path, edit hint and
 * snippet, image resizing). Every tool call goes through the parent's gate before it runs (owner hooks, extension
 * `tool_call` handlers, file checkpoints, the task plan guard) and through the parent's result handling after it
 * (extension `tool_result` handlers, image normalization, owner PostToolUse hooks). It cannot call `task` or
 * `explore` itself.
 */

import type { AgentOptions, ThinkingLevel } from "theoses-agent-core";
import type { Api, Model } from "theoses-ai";
import { type Static, Type } from "typebox";
import { createBudgetedAgent } from "./background-agent.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProviderHooks } from "./provider-hooks.ts";
import { type BashToolOptions, createBashToolDefinition } from "./tools/bash.ts";
import { createEditToolDefinition, type EditToolOptions } from "./tools/edit.ts";
import { createFindToolDefinition } from "./tools/find.ts";
import { createGrepToolDefinition } from "./tools/grep.ts";
import { createLsToolDefinition } from "./tools/ls.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./tools/read.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";
import { createWriteToolDefinition } from "./tools/write.ts";

export const TASK_CAPS = { lines: 40, maxTurns: 30, maxInputTokens: 1_500_000 } as const;

/** What a task can use. Not `task` or `explore`: one level of delegation. */
export const TASK_AGENT_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

export interface TaskResult {
	/** The summary the parent sees (line-capped). Never the sub-agent's tool output. */
	answer: string;
	/**
	 * false when the sub-agent did not summarize on its own, usually because the budget ran out: the work may be
	 * partly done and files partly changed. `answer` then holds what it reported on its final turn, or INCOMPLETE if nothing.
	 */
	complete: boolean;
	/** Includes the final write-up turn. */
	turnsUsed: number;
	inputTokens: number;
	outputTokens: number;
	/** The budget limits the run reached, e.g. "30-turn cap"; empty when none. */
	stoppedBy: string[];
}

const FINALIZE_PROMPT =
	"Stop. Write your final summary now from what you have done. Say plainly what is finished, what is not, and what you did not verify. Do not call any tools.";

const PARTLY_CHANGED = "Files may be partly changed; check with git status and git diff before relying on it.";

function buildTaskSystemPrompt(cwd: string): string {
	return `You are a sub-agent working on one self-contained task for a parent agent. You have your own context; the parent sees only your final message, never your tool calls or their output.

Working directory: ${cwd}

Rules:
1. The brief is all you know. Do the task completely and on your own; do not ask questions. If something blocks you, stop and say exactly what.
2. Read a file before you edit it. Keep changes minimal and in the style of the code around them. Change only what the task needs.
3. Check your work before you finish: run the relevant test or command and look at the result.
4. Your final message is a summary of at most ${TASK_CAPS.lines} lines: what you changed (file:line), how you checked it (the command and what it printed), and anything left undone or uncertain. Pointers, not pasted code or output.
5. You have at most ${TASK_CAPS.maxTurns} turns. If you run out, you get one last turn with no tools to write your summary: say what is finished, what is not, and what you did not verify. The parent is told the work is incomplete.`;
}

export interface RunTaskOptions {
	prompt: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	modelRuntime: ModelRuntime;
	signal?: AbortSignal;
	onStatus?: (status: string) => void;
	providerHooks?: ProviderHooks;
	/** The parent's gate for tool calls; see the module comment. */
	beforeToolCall?: AgentOptions["beforeToolCall"];
	/** The parent's tool result handling; see the module comment. */
	afterToolCall?: AgentOptions["afterToolCall"];
	toolOptions?: TaskToolOptions;
}

/** The parent's settings for the tools a task shares with it. */
export interface TaskToolOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	edit?: EditToolOptions;
}

export async function runTask(options: RunTaskOptions): Promise<TaskResult> {
	const toolOptions = options.toolOptions ?? {};
	// The tools have different detail types; the wrapper only needs the common ToolDefinition shape.
	const definitions: ToolDefinition<any, any, any>[] = [
		createReadToolDefinition(options.cwd, toolOptions.read),
		createGrepToolDefinition(options.cwd),
		createFindToolDefinition(options.cwd),
		createLsToolDefinition(options.cwd),
		createEditToolDefinition(options.cwd, toolOptions.edit),
		createWriteToolDefinition(options.cwd),
		createBashToolDefinition(options.cwd, toolOptions.bash),
	];
	const handle = createBudgetedAgent({
		systemPrompt: buildTaskSystemPrompt(options.cwd),
		model: options.model,
		tools: definitions.map((definition) => wrapToolDefinition(definition)),
		modelRuntime: options.modelRuntime,
		maxTurns: TASK_CAPS.maxTurns,
		maxInputTokens: TASK_CAPS.maxInputTokens,
		signal: options.signal,
		providerHooks: options.providerHooks,
		thinkingLevel: options.thinkingLevel,
		beforeToolCall: options.beforeToolCall,
		afterToolCall: options.afterToolCall,
		onStatus: options.onStatus,
		capLines: TASK_CAPS.lines,
	});
	// A cap can cut the job off mid-work; the handle then gives it one last turn with no tools to say what is
	// done and what is not, so the parent gets that instead of reconstructing it from git.
	const { status, text, stats, stoppedBy } = await handle.promptToAnswer(options.prompt, {
		finalizePrompt: FINALIZE_PROMPT,
	});

	const why =
		stoppedBy.length > 0
			? `hit its ${stoppedBy.join(" and ")}`
			: options.signal?.aborted
				? "was stopped"
				: "ended without a final summary";
	let answer: string;
	if (status === "complete") {
		answer = text;
	} else if (status === "partial") {
		answer = `INCOMPLETE: the task ${why}. ${PARTLY_CHANGED}\nWhat it reported:\n${text}`;
	} else {
		answer = `INCOMPLETE: the task ${why} and wrote no summary. ${PARTLY_CHANGED}`;
	}
	return {
		answer,
		complete: status === "complete",
		turnsUsed: stats.turns,
		inputTokens: stats.inputTokens,
		outputTokens: stats.outputTokens,
		stoppedBy,
	};
}

const taskSchema = Type.Object({
	description: Type.String({ description: "Three to six words naming the task, for the status line" }),
	prompt: Type.String({
		description:
			"The full brief. The sub-agent knows nothing else: say what to do, where, what done looks like, and what must not change.",
	}),
});
type TaskInput = Static<typeof taskSchema>;

export interface TaskToolDeps {
	modelRuntime: ModelRuntime;
	cwd: string;
	/** The parent's current model and thinking level, read when the tool runs. */
	getModel: () => Model<Api> | undefined;
	getThinkingLevel: () => ThinkingLevel;
	providerHooks?: ProviderHooks;
	beforeToolCall?: AgentOptions["beforeToolCall"];
	afterToolCall?: AgentOptions["afterToolCall"];
	toolOptions?: TaskToolOptions;
}

export function createTaskToolDefinition(deps: TaskToolDeps): ToolDefinition<typeof taskSchema> {
	return {
		name: "task",
		label: "task",
		description:
			"Hand one self-contained piece of work (a change, a fix, an investigation that needs edits or commands) to a sub-agent with its own context. It reads, edits and runs commands on its own, and returns only a short summary of what it changed and how it checked it; its tool output never enters your context.",
		promptSnippet: "Delegate a self-contained piece of work to a sub-agent; only its summary returns",
		promptGuidelines: [
			"Use `task` for work that is self-contained and would bury your context in reads and command output. Do small or tightly coupled changes yourself.",
			"A `task` starts with nothing but its `prompt`: give the goal, the files, what done looks like and what must not change. After it returns, verify what matters yourself; the summary is a claim, not proof.",
		],
		parameters: taskSchema,
		// Two tasks editing the same files at once would collide.
		executionMode: "sequential",
		execute: async (_toolCallId, { prompt }: TaskInput, signal, onUpdate) => {
			const model = deps.getModel();
			if (!model) throw new Error("No model is selected, so a task cannot run.");
			const result = await runTask({
				prompt,
				cwd: deps.cwd,
				model,
				thinkingLevel: deps.getThinkingLevel(),
				modelRuntime: deps.modelRuntime,
				signal,
				providerHooks: deps.providerHooks,
				beforeToolCall: deps.beforeToolCall,
				afterToolCall: deps.afterToolCall,
				toolOptions: deps.toolOptions,
				onStatus: (status) => onUpdate?.({ content: [{ type: "text", text: status }], details: undefined }),
			});
			return { content: [{ type: "text", text: result.answer }], details: result };
		},
	};
}
