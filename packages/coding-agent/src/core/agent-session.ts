/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "theoses-agent-core";
import { contentText } from "theoses-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "theoses-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "theoses-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { markBusy } from "./busy-marker.ts";
import { FINAL_REPLY_NOTE } from "./claim-check.ts";
import { formatClockAnnotation, stripClockAnnotation } from "./clock.ts";
import {
	type HookRunContext,
	MAX_STOP_HOOK_PUSHES,
	runSessionHooks as runCommandSessionHooks,
	runPostToolUse,
	runPreToolUse,
	runStopHooks,
	runUserPromptSubmit,
	STOP_HOOK_CUSTOM_TYPE,
} from "./command-hooks.ts";
import {
	activeContextWindowTurns,
	CACHE_WARM_WINDOW_MS,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
} from "./compaction/index.ts";
import { type CompactionRun, createCompactionRun, type Summarizer } from "./compaction/run.ts";
import { pruneFinishedTurnOutputs } from "./context-pruning.ts";
import { THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { createExploreToolDefinition } from "./explorer.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type RegisteredTool,
	type ReplacedSessionContext,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	applyFileRewind,
	FileCheckpoints,
	planFileRewind,
	type RewindPlan,
	type RewindResult,
	sweepCheckpoints,
} from "./file-checkpoints.ts";
import { createMemoryPromotion, type MemoryPromotion } from "./memory-promotion.ts";
import { FileMemoryStore } from "./memory-store.ts";
import { type BashExecutionMessage, type CustomMessage, createCustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { createOperationLoop, type OperationLoop } from "./operation-loop.ts";
import { reviewPlan } from "./plan-reviewer.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { extensionProviderHooks } from "./provider-hooks.ts";
import { createResearchToolDefinition, ResearchJobs } from "./researcher.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { logServedProvider } from "./served-provider-log.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import { saveImageFile } from "./session-images.ts";
import {
	type BranchSummaryEntry,
	getLatestCompactionEntry,
	limitActiveContextMessages,
	type OperationFinishedEntry,
	type OperationOutcome,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";
import { createSessionSystemPrompt, type SessionSystemPrompt } from "./session-system-prompt.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createTaskToolDefinition, type TaskToolOptions } from "./task-agent.ts";
import { TaskPlanGuard } from "./task-plan-guard.ts";
import { resolveThinkingLevel } from "./thinking-level.ts";
import { createToolRegistry, initialActiveToolNames, type ToolRegistry } from "./tool-registry.ts";
import { currentRunMessages, textOf } from "./tool-runs.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { generateUnifiedPatch } from "./tools/edit-diff.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { spillPrunedText } from "./tools/output-shaping.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { settleTurn } from "./turn-settlement.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" | "turns" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow" | "turns";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow" | "turns";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Tools discovered from channel-neutral HTTP sidecars or MCP servers. */
	externalTools?: RegisteredTool[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write, working_note, note_operations, remember, save_note, recall_turns, convert_doc, web_search, generate_image] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image data URLs or already-normalized image attachments. */
	images?: ImageContent[] | string[];
	/** Bounded content of the message this prompt is replying to. */
	replyContext?: string;
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/**
	 * User text Turn Settlement sees for this prompt, when it should differ from `text` (Telegram passes
	 * "" for attachment-only turns, whose prompt is the attachment note). Defaults to `text`.
	 */
	settlementText?: string;
}

/** Options for steer() and followUp(). */
export interface QueueOptions {
	/** Bounded content of the message this one is replying to. */
	replyContext?: string;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
}

/** How the operation a prompt() ran ended, after retries and overflow recovery. */
export interface PromptResult {
	outcome: OperationFinishedEntry["outcome"];
	/** The final provider error, only when outcome is "failed". */
	finalError?: { message: string; provider: string; model: string };
	/** One-line Task Plan status when this operation created or changed the plan (issue #382). */
	planStatus?: string;
}

const REPLY_CONTEXT_CAP = 2000;
/** Issue #173: bounds one auto-logged bash command line in the Working Note (the command, not its output — the how, not the what). */
const BASH_AUTO_LOG_COMMAND_CAP = 200;
const ABORT_NOTICE =
	"[Abort Notice: The previous task was cancelled. Do not resume it unless the user explicitly asks you to.]";
/** Issue #246: distinct from ABORT_NOTICE — this wasn't a deliberate stop, the process died mid-turn. */
const INTERRUPTED_NOTICE =
	"[Interrupted Notice: The previous task was cut off mid-turn by a restart or crash, not cancelled by the user. Tell the user their last task was interrupted before continuing, and ask whether they want it resumed rather than assuming.]";

function normalizeImages(images: PromptOptions["images"]): ImageContent[] | undefined {
	if (!images) return undefined;
	if (images.every((image): image is ImageContent => typeof image !== "string")) return images;
	return images.map((dataUrl) => {
		if (typeof dataUrl !== "string") throw new Error("Image attachments must use one consistent format");
		const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl);
		if (!match) throw new Error("Image attachments must be base64 data URLs");
		return { type: "image", data: dataUrl.slice(match[0].length), mimeType: match[1] };
	});
}

function addReplyContext(text: string, replyContext: string | undefined): string {
	if (!replyContext) return text;
	return `[Quoted message context]\n${replyContext.slice(0, REPLY_CONTEXT_CAP)}\n[/Quoted message context]\n\n${text}`;
}

/**
 * Decorates the user's prompt text with everything prompt() prepends/appends before it reaches the agent: an
 * Abort/Interrupted Notice when the prior operation didn't finish cleanly (never both — only the most recent
 * outcome applies), quoted-reply context, and the clock annotation. Pure and exported so it can be tested and
 * reused without an AgentSession instance.
 */
export function decoratePromptText(
	text: string,
	lastOutcome: OperationOutcome | undefined,
	replyContext: string | undefined,
	clockAnnotation: string,
): string {
	const notice =
		lastOutcome === "aborted"
			? `${ABORT_NOTICE}\n\n`
			: lastOutcome === "interrupted"
				? `${INTERRUPTED_NOTICE}\n\n`
				: "";
	return `${notice}${addReplyContext(text, replyContext)}${clockAnnotation}`;
}

/**
 * Prefixes a steered message. Without it a mid-task message reads like a fresh request, and a model that
 * answers it in text alone ends the run, leaving the task it was working on unfinished.
 */
export const MID_TASK_NOTE =
	"[Sent while you were working on the current task. If it is a question, answer it briefly; if it changes the task, adjust. Then keep working: put your next tool call in the same response, because a text-only response ends the task. Stop only if the user asks you to stop or wait, or if the message conflicts with what was agreed; then ask.]";

/** Longer than a default command hook's 30s timeout; a handler that never settles must not hang a run forever. */
const INTAKE_HOLD_MS = 60_000;

/** A message waiting in the steering or follow-up queue. */
interface QueuedInput {
	/** What was submitted, for the queue display and for restoring it to an editor. */
	text: string;
	/** The message handed to the agent; `message_start` carries this same object when it is delivered. */
	message: AgentMessage;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Pending steering messages, for display. Removed when delivered. */
	private _steeringQueue: QueuedInput[] = [];
	/** Pending follow-up messages, for display. Removed when delivered. */
	private _followUpQueue: QueuedInput[] = [];
	/** Messages accepted while a run was active and still in intake; the run waits for them before it ends. */
	private readonly _inputInIntake = new Set<Promise<unknown>>();
	/** How long a run waits for messages still in intake before it ends anyway (see _waitForInputInIntake). */
	private _intakeHoldMs = INTAKE_HOLD_MS;
	/** Bumped by clearQueue(), so a message still in intake when the queue was cleared is dropped, not queued. */
	private _queueGeneration = 0;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Research job accounting; outlives runtime rebuilds so the per-session limits hold. */
	private _researchJobs = new ResearchJobs();

	// Compaction state
	private readonly _compactionRun: CompactionRun;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	/** Retry, overflow recovery and post-run compaction within one operation. */
	private readonly _operationLoop: OperationLoop;
	/** What the latest operation ended with; returned by prompt(). */
	private _lastOperationResult: PromptResult | undefined = undefined;

	/** Turn Settlement input: the latest prompt's user text (or its settlementText override). */
	private _settlementText = "";

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private readonly _memoryStore = new FileMemoryStore();
	private readonly _memoryPromotion: MemoryPromotion;
	private readonly _taskPlanGuard: TaskPlanGuard;
	private readonly _fileCheckpoints: FileCheckpoints;

	private readonly _tools: ToolRegistry;

	// Base system prompt for the current operation (without extension appends), refreshed once per
	// prompt()/sendCustomMessage() call from _systemPrompt below.
	private _baseSystemPrompt = "";
	private readonly _systemPrompt: SessionSystemPrompt;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._tools = createToolRegistry({
			customTools: config.customTools ?? [],
			externalTools: config.externalTools ?? [],
			allowedToolNames: config.allowedToolNames ? new Set(config.allowedToolNames) : undefined,
			excludedToolNames: config.excludedToolNames ? new Set(config.excludedToolNames) : undefined,
			initialActiveToolNames: config.initialActiveToolNames,
			activate: (names) => this.setActiveToolsByName([...this.getActiveToolNames(), ...names]),
		});
		this._cwd = config.cwd;
		this._systemPrompt = createSessionSystemPrompt({
			cwd: this._cwd,
			resourceLoader: this._resourceLoader,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			getToolPromptSnippets: () => this._tools.promptSnippets,
			getToolPromptGuidelines: () => this._tools.promptGuidelines,
		});
		this._modelRuntime = config.modelRuntime;
		this._memoryPromotion = createMemoryPromotion({
			sessionManager: this.sessionManager,
			modelRuntime: this._modelRuntime,
			memoryStore: this._memoryStore,
		});
		this._compactionRun = createCompactionRun({
			sessionManager: this.sessionManager,
			getExtensionRunner: () => this._extensionRunner,
			memoryPromotion: this._memoryPromotion,
			getCompactionSettings: () => this.settingsManager.getCompactionSettings(),
			setMessages: (messages) => {
				this.agent.state.messages = messages;
			},
			emit: (event) => this._emit(event),
			prepareSummarizer: () => this._prepareSummarizer(),
		});
		this._operationLoop = createOperationLoop({
			agent: this.agent,
			compactionRun: this._compactionRun,
			getRetrySettings: () => this.settingsManager.getRetrySettings(),
			getCompactionSettings: () => this.settingsManager.getCompactionSettings(),
			getModel: () => this.model,
			getBranch: () => this.sessionManager.getBranch(),
			emit: (event) => this._emit(event),
			finish: (outcome, msg) => this._finishOperation(outcome, msg),
			waitForInput: () => this._waitForInputInIntake(),
		});
		this._fileCheckpoints = new FileCheckpoints(this.sessionManager, this._cwd);
		if (this.sessionManager.isPersisted()) sweepCheckpoints(this.sessionManager.getCheckpointDirectory());
		this._taskPlanGuard = new TaskPlanGuard({
			cwd: this._cwd,
			getPlan: () => this.sessionManager.getTaskPlan(),
			setPlan: (plan) => this.sessionManager.setTaskPlan(plan),
			// Without the task_plan tool active the model could never satisfy the gate.
			enabled: () => this.settingsManager.getTaskPlanEnabled() && this.getActiveToolNames().includes("task_plan"),
			runMessages: () => currentRunMessages(this.agent.state.messages),
			review: (input) =>
				reviewPlan({
					...input,
					cwd: this._cwd,
					modelRuntime: this._modelRuntime,
					providerHooks: extensionProviderHooks(() => this._extensionRunner),
					signal: this.agent.signal,
				}),
			generatePatch: generateUnifiedPatch,
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: config.initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	/** Turn Settlement's route into Durable Memory (see turn-settlement.ts, memory-promotion.ts). */
	get memoryPromotion(): MemoryPromotion {
		return this._memoryPromotion;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _hookContext(): HookRunContext {
		return { cwd: this._cwd, sessionId: this.sessionId, signal: this.agent.signal };
	}

	/** Runs the owner's SessionStart or SessionEnd command hooks (command-hooks.ts). */
	async runSessionHooks(event: "SessionStart" | "SessionEnd", reason: string): Promise<void> {
		await runCommandSessionHooks(this.settingsManager.getCommandHooks(), event, this._hookContext(), reason);
	}

	/**
	 * Stop hooks (command-hooks.ts). One that blocks feeds its reason back as a custom message so the run continues,
	 * at most MAX_STOP_HOOK_PUSHES times per run, so a hook that never relents cannot hold a run open forever.
	 */
	private async _runStopHooks(): Promise<AgentMessage[]> {
		const hooks = this.settingsManager.getCommandHooks();
		if (!hooks.Stop) return [];
		const run = currentRunMessages(this.agent.state.messages);
		const pushes = run.filter((m) => m.role === "custom" && m.customType === STOP_HOOK_CUSTOM_TYPE).length;
		if (pushes >= MAX_STOP_HOOK_PUSHES) return [];
		const last = [...run].reverse().find((m) => m.role === "assistant");
		const lastAssistantText = last?.role === "assistant" ? textOf(last.content) : "";
		const reason = await runStopHooks(hooks, this._hookContext(), { stopHookActive: pushes > 0, lastAssistantText });
		if (reason === undefined) return [];
		return [
			createCustomMessage(
				STOP_HOOK_CUSTOM_TYPE,
				`[System: stop hook]\n${reason}\n\n${FINAL_REPLY_NOTE}`,
				true,
				undefined,
				new Date().toISOString(),
			),
		];
	}

	/**
	 * The gate every tool call passes before it runs: task plan guard, owner command hooks, extension `tool_call`
	 * handlers, then the file checkpoint. The main agent uses it, and so does a `task` sub-agent, so delegating
	 * work does not step around any of them.
	 */
	private async _gateToolCall({ toolCall, args }: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
		const input = args as Record<string, unknown>;
		const planGate = this._taskPlanGuard.beforeToolCall(toolCall.name, input);
		if (planGate) return planGate;
		// The owner's command hooks run first: one can block the call or rewrite its input, and the extensions
		// and the checkpoint below see the rewritten input.
		const hookBlock = await runPreToolUse(this.settingsManager.getCommandHooks(), this._hookContext(), {
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			input,
		});
		if (hookBlock) return hookBlock;

		const runner = this._extensionRunner;
		let result: Awaited<ReturnType<typeof runner.emitToolCall>> | undefined;
		if (runner.hasHandlers("tool_call")) {
			try {
				result = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}
		// Last, so the checkpoint saves the file the tool will really change and nothing for a blocked call.
		if (!result?.block) this._fileCheckpoints.beforeToolCall(toolCall.name, input);
		return result;
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._gateToolCall(context);

		this.agent.beforeStop = async () => {
			const pushed = await this._taskPlanGuard.beforeStop();
			return pushed.length > 0 ? pushed : await this._runStopHooks();
		};

		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/**
	 * After every tool call of this session and of its task sub-agent: extension `tool_result` handlers, image
	 * normalization, then the owner's PostToolUse hooks.
	 */
	private async _afterToolCall({
		toolCall,
		args,
		result,
		isError,
	}: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
		});

		// The owner's PostToolUse hooks run last, on what the model would now see, and can add context to it.
		const finalIsError = hookResult?.isError ?? isError;
		const hookContext = await runPostToolUse(this.settingsManager.getCommandHooks(), this._hookContext(), {
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			input: args as Record<string, unknown>,
			content: normalizedContent,
			isError: finalIsError,
		});
		const finalContent =
			hookContext.length > 0
				? [...normalizedContent, ...hookContext.map((text) => ({ type: "text" as const, text: `[Hook] ${text}` }))]
				: normalizedContent;

		if (!hookResult && finalContent === content) {
			return undefined;
		}

		return {
			content: finalContent,
			details: hookResult?.details,
			isError: finalIsError,
			usage: hookResult?.usage,
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this._steeringQueue.map((queued) => queued.text),
			followUp: this._followUpQueue.map((queued) => queued.text),
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			// The agent delivers the same object it was queued with, so two identical texts never match the wrong entry.
			for (const queue of [this._steeringQueue, this._followUpQueue]) {
				const index = queue.findIndex((queued) => queued.message === event.message);
				if (index !== -1) {
					queue.splice(index, 1);
					this._emitQueueUpdate();
					break;
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		// The retry decision is made once, here: agent_end reports it and the Operation Loop acts on it.
		if (event.type === "agent_end") {
			this._emit({ ...event, willRetry: this._operationLoop.agentEnded(event) });
		} else {
			this._emit(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			if (event.message.role === "assistant") logServedProvider(event.message);
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
		}
		this._operationLoop.observe(event);
	};

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Whether the provider's prompt cache for the current system prompt is probably still warm. The system
	 * prompt ends with dynamic sections (Working Note, artifact catalog) that grow during bash-heavy work, and
	 * it is rebuilt before every user turn; rebuilding while warm changes message 0 and invalidates the cached
	 * prefix of the entire conversation. While warm the previous prompt is kept, since the recent turns still
	 * show what the new note lines and artifact paths would say; the next cold prompt picks them all up.
	 */
	private _isPromptCacheWarm(): boolean {
		const lastAssistant = this._findLastAssistantMessage();
		return lastAssistant !== undefined && Date.now() - lastAssistant.timestamp < CACHE_WARM_WINDOW_MS;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured Theoses or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** A tool-set or resource change: rebuild now, so the prompt the getter returns is always the one the model sees. */
	private _rebuildSystemPromptNow(): void {
		this._systemPrompt.invalidate();
		this._baseSystemPrompt = this._systemPrompt.refresh(this._systemPromptRefreshInput());
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	private _systemPromptRefreshInput(): {
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		activeTools: string[];
		cacheWarm: boolean;
	} {
		return {
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
			activeTools: this.getActiveToolNames(),
			cacheWarm: this._isPromptCacheWarm(),
		};
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._operationLoop.retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return this._tools.getAll();
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._tools.getDefinition(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this.agent.state.tools = this._tools.resolve(toolNames);
		this._rebuildSystemPromptNow();
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionRun.activeReason !== undefined || this._branchSummaryAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	/** What putting the files back to how they were before the user message `userEntryId` would do (file-checkpoints.ts). */
	previewFileRewind(userEntryId: string): RewindPlan {
		return planFileRewind(this.sessionManager.getBranch(), userEntryId);
	}

	/** Puts the files changed since the user message `userEntryId` back to how they were before it. Leaves the conversation alone. */
	rewindFiles(userEntryId: string): RewindResult {
		if (this._isAgentRunActive) throw new Error("Stop the current run before rewinding files");
		return applyFileRewind(this.previewFileRewind(userEntryId), this.sessionManager.getCheckpointDirectory());
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<PromptResult | undefined> {
		this._isAgentRunActive = true;
		this._lastOperationResult = undefined;
		this._taskPlanGuard.startOperation();
		const releaseBusy = markBusy(this.sessionId);
		try {
			// The caller (prompt()/sendCustomMessage()) already refreshed _baseSystemPrompt once for this
			// operation; no rebuild here, just apply whichever prompt is current.
			this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
			await this.agent.prompt(messages);
			while ((await this._operationLoop.afterRun()) === "continue") {
				await this.agent.continue();
			}
			return this._lastOperationResult;
		} finally {
			try {
				this._systemPromptOverride = undefined;
				this._flushPendingBashMessages();
				await this._emitAgentSettled();
			} finally {
				// Last, so the self-updater does not restart the service in the middle of settlement.
				releaseBusy();
			}
		}
	}

	/**
	 * Records the one outcome of an operation; called by the Operation Loop, which decides when. Retries and
	 * overflow recovery happen inside an operation, never after it.
	 */
	private _finishOperation(outcome: OperationFinishedEntry["outcome"], msg: AssistantMessage | undefined): void {
		this.sessionManager.appendOperationFinished(outcome);
		const finalError =
			outcome === "failed" && msg?.errorMessage
				? { message: msg.errorMessage, provider: msg.provider, model: msg.model }
				: undefined;
		this._lastOperationResult = { outcome, finalError, planStatus: this._taskPlanGuard.planStatus() };
		if (outcome !== "completed") {
			// Backstop for a note no completed operation cleared.
			if (msg && this.sessionManager.isWorkingNoteStale()) this.sessionManager.clearWorkingNote();
			return;
		}
		// Issue #173: the Working Note is a scratchpad for the operation in
		// progress, not a cross-operation memory — the harness owns clearing
		// it so stale context from a finished task never bleeds into an
		// unrelated later one, instead of relying on the model to remember
		// to call working_note({ clear: true }). Left in place on
		// "aborted"/"failed" so the WORKING_NOTE_STALE_TURNS backstop can
		// still make use of it.
		if (this.sessionManager.getWorkingNote()) {
			this.sessionManager.clearWorkingNote();
		}
		// Turn Settlement: only a completed operation of a non-CLI Channel Session (every header defaults
		// to channel "cli"). CLI still reaches Durable Memory, but only through compaction distilling the
		// turns it drops (see CONTEXT.md's Turn Settlement entry) — settlement itself never runs for it.
		if (this.sessionManager.getChannelSessionKey().channel !== "cli") {
			settleTurn(this, this._settlementText);
		}
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via theoses.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<PromptResult | undefined> {
		const generation = this._queueGeneration;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via theoses.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionRun.activeReason === "manual") {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Intake, then queue the message if a run is active. A run that was active when it arrived waits for this
			// step (see _holdRunFor); extension commands above are never held, since one may itself wait for idle.
			const admit = async (): Promise<{ text: string; images: ImageContent[] | undefined } | "done"> => {
				const input = await this._intake(text, normalizeImages(options?.images), {
					source: options?.source ?? "interactive",
					streamingBehavior: this.isStreaming ? options?.streamingBehavior : undefined,
					expandPromptTemplates,
				});
				if (!input) return "done";
				// Last prompt wins: one agent_end can cover queued follow-ups, and settlement wants the newest intent.
				this._settlementText = options?.settlementText ?? text;
				if (!this.isStreaming) return input;
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				// Dropped when the queue was cleared (stop) while this message was in intake.
				if (generation === this._queueGeneration) {
					this._enqueue(options.streamingBehavior, text, input, options.replyContext);
				}
				return "done";
			};
			const admitted = this.isStreaming ? await this._holdRunFor(admit()) : await admit();
			if (admitted === "done") {
				preflightResult?.(true);
				return;
			}
			const input = admitted;

			const currentImages = input.images;
			const contextualText = decoratePromptText(
				input.text,
				this.sessionManager.getLastOperationOutcome(),
				options?.replyContext,
				formatClockAnnotation(),
			);

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._operationLoop.beforePrompt(lastAssistant);
			}

			const messagesBeforeLimit = this.agent.state.messages.length;
			this.agent.state.messages = limitActiveContextMessages(
				this.agent.state.messages,
				activeContextWindowTurns(this.settingsManager.getCompactionSettings()),
			);
			if (process.env.THEOSES_DEBUG_CACHE_PREFIX && this.agent.state.messages.length !== messagesBeforeLimit) {
				console.error(
					`[cache-prefix] sliding window dropped ${messagesBeforeLimit - this.agent.state.messages.length} messages`,
				);
			}
			// Everything in the list is from a finished turn: the new user message is added below. Cutting the
			// finished turn's oversized tool output now, while its messages are being rewritten anyway (reasoning
			// is dropped from earlier turns), does not add a prompt-cache break of its own.
			const pruned = pruneFinishedTurnOutputs(this.agent.state.messages, {
				...this.settingsManager.getContextPruningSettings(),
				spill: (name, text) => spillPrunedText(this.sessionManager, name, text),
				// The same content-addressed file the session log references, so a note can point straight at it.
				// An in-memory session has no directory to save into (and must not create one), so its images are kept.
				saveImage: (data, mimeType) =>
					this.sessionManager.isPersisted()
						? saveImageFile(this.sessionManager.getArtifactDirectory(), data, mimeType)
						: undefined,
			});
			if (pruned.stats.toolResults > 0 || pruned.stats.toolCallArguments > 0 || pruned.stats.images > 0) {
				this.agent.state.messages = pruned.messages;
				console.error(
					`[context-pruning] cut ${pruned.stats.toolResults} tool results, ${pruned.stats.toolCallArguments} ` +
						`tool-call arguments and ${pruned.stats.images} images from finished turns ` +
						`(${pruned.stats.charsRemoved} chars of text)`,
				);
			}
			// One rebuild for this operation, before extensions see the prompt (before_agent_start below).
			this._baseSystemPrompt = this._systemPrompt.refresh(this._systemPromptRefreshInput());

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: contextualText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				contextualText,
				currentImages,
				this._baseSystemPrompt,
				this._systemPrompt.options(),
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		return this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call. Goes through the same intake as prompt(): the owner's
	 * UserPromptSubmit hooks, extension input handlers, skill and template expansion.
	 * @param images Optional image attachments to include with the message
	 * @returns false when a hook or input handler blocked or handled the message, so nothing was queued
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], options?: QueueOptions): Promise<boolean> {
		return this._queueInput("steer", text, images, options);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Goes through the same intake as prompt() (see steer()).
	 * @param images Optional image attachments to include with the message
	 * @returns false when a hook or input handler blocked or handled the message, so nothing was queued
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], options?: QueueOptions): Promise<boolean> {
		return this._queueInput("followUp", text, images, options);
	}

	private async _queueInput(
		mode: "steer" | "followUp",
		text: string,
		images: ImageContent[] | undefined,
		options: QueueOptions | undefined,
	): Promise<boolean> {
		// Extension commands cannot be queued; prompt() runs them immediately.
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		const generation = this._queueGeneration;
		const queue = async () => {
			const input = await this._intake(text, images, {
				source: options?.source ?? "interactive",
				streamingBehavior: mode,
				expandPromptTemplates: true,
			});
			if (!input || generation !== this._queueGeneration) return false;
			this._settlementText = text;
			this._enqueue(mode, text, input, options?.replyContext);
			return true;
		};
		return this.isStreaming ? this._holdRunFor(queue()) : queue();
	}

	/**
	 * The intake every submitted message goes through, whether it starts a run or is queued into one: the owner's
	 * UserPromptSubmit hooks (not for extension-sent messages), extension input handlers, then skill and template
	 * expansion. Undefined when a hook or handler blocked or handled the message.
	 */
	private async _intake(
		text: string,
		images: ImageContent[] | undefined,
		options: { source: InputSource; streamingBehavior?: "steer" | "followUp"; expandPromptTemplates: boolean },
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		let currentText = text;
		let currentImages = images;
		// The owner's UserPromptSubmit hooks see what a person typed, not what an extension sent on their behalf.
		if (options.source !== "extension") {
			const submitted = await runUserPromptSubmit(
				this.settingsManager.getCommandHooks(),
				this._hookContext(),
				currentText,
			);
			if (submitted.action === "handled") {
				await this.sendCustomMessage(
					{
						customType: "hook-blocked",
						content: `A hook blocked this prompt: ${submitted.reason}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return undefined;
			}
			if (submitted.action === "transform") currentText = submitted.text;
		}
		if (this._extensionRunner.hasHandlers("input")) {
			const inputResult = await this._extensionRunner.emitInput(
				currentText,
				currentImages,
				options.source,
				options.streamingBehavior,
			);
			if (inputResult.action === "handled") return undefined;
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}
		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		if (options.expandPromptTemplates) {
			currentText = this._expandSkillCommand(currentText);
			currentText = expandPromptTemplate(currentText, [...this.promptTemplates]);
		}
		return { text: currentText, images: currentImages };
	}

	/**
	 * Queues a message that passed intake into the running operation. It carries no Abort Notice: that belongs to
	 * the message that starts an operation, and this one joins the operation in flight. A steer is marked as
	 * arriving mid-task.
	 */
	private _enqueue(
		mode: "steer" | "followUp",
		submittedText: string,
		input: { text: string; images: ImageContent[] | undefined },
		replyContext: string | undefined,
	): void {
		const body = mode === "steer" ? `${MID_TASK_NOTE}\n${input.text}` : input.text;
		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: decoratePromptText(body, undefined, replyContext, formatClockAnnotation()) },
		];
		if (input.images) content.push(...input.images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		(mode === "steer" ? this._steeringQueue : this._followUpQueue).push({ text: submittedText, message });
		this._emitQueueUpdate();
		if (mode === "steer") this.agent.steer(message);
		else this.agent.followUp(message);
	}

	/**
	 * Keeps the running operation from ending until `work` (a message accepted mid-run, still in intake) settles.
	 * Hooks can take seconds; without this the run could end first and leave the message queued in an idle agent.
	 */
	private async _holdRunFor<T>(work: Promise<T>): Promise<T> {
		this._inputInIntake.add(work);
		try {
			return await work;
		} finally {
			this._inputInIntake.delete(work);
		}
	}

	/**
	 * Bounded by _intakeHoldMs: an input handler that itself waits for the session to go idle would otherwise hang
	 * the run forever. Past the bound the run ends, and a message that finishes intake later stays queued until
	 * the next prompt.
	 */
	private async _waitForInputInIntake(): Promise<void> {
		const deadline = Date.now() + this._intakeHoldMs;
		while (this._inputInIntake.size > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled([...this._inputInIntake]),
				new Promise((resolve) => {
					timer = setTimeout(resolve, remaining);
				}),
			]);
			clearTimeout(timer);
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			// One rebuild for this operation, same rule as prompt().
			this._baseSystemPrompt = this._systemPrompt.refresh(this._systemPromptRefreshInput());
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = this.getSteeringMessages();
		const followUp = this.getFollowUpMessages();
		this._queueGeneration++;
		this._steeringQueue = [];
		this._followUpQueue = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringQueue.length + this._followUpQueue.length;
	}

	/** Pending steering messages, as submitted */
	getSteeringMessages(): string[] {
		return this._steeringQueue.map((queued) => queued.text);
	}

	/** Pending follow-up messages, as submitted */
	getFollowUpMessages(): string[] {
		return this._followUpQueue.map((queued) => queued.text);
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		await this._applyModel(model, "set", options);
	}

	/**
	 * The one place a model change is applied (issue #418); setModel and both kinds of cycling only choose the model.
	 * Picks the thinking level for the new model before switching (a scoped model's own level beats the per-model
	 * default, which beats the global default), sets and records the model, saves it as the default only when
	 * `options.persist` is set, applies the thinking level (clamped to what the new model supports; persisting a model
	 * does not rewrite the global thinking default), then emits `model_select`. The auth check stays with setModel:
	 * cycling only picks from models whose provider already has credentials.
	 */
	private async _applyModel(
		model: Model<any>,
		source: "set" | "cycle",
		options: ModelMutationOptions,
		scopedThinkingLevel?: ThinkingLevel,
	): Promise<void> {
		const previousModel = this.model;
		const thinkingLevel = resolveThinkingLevel({
			model,
			explicit: scopedThinkingLevel,
			perModel: this.settingsManager.getModelThinkingLevel(model.provider, model.id),
			globalDefault: this.settingsManager.getDefaultThinkingLevel(),
			current: this.thinkingLevel,
		});
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}
		this.setThinkingLevel(thinkingLevel);
		await this._emitModelSelect(model, previousModel, source);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		await this._applyModel(next.model, "cycle", options, next.thinkingLevel);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		await this._applyModel(nextModel, "cycle", options);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Model used for compaction, branch summaries, and task-boundary detection. Prefers the
	 * dedicated `summarizationProvider`/`summarizationModel` settings (issue #212) so switching
	 * the active chat model never silently breaks a session's own maintenance calls; falls back
	 * to the active chat model when no override is configured or the override has no usable auth.
	 */
	private _summarizationModel(): Model<any> | undefined {
		const provider = this.settingsManager.getSummarizationProvider();
		const modelId = this.settingsManager.getSummarizationModel();
		if (provider && modelId) {
			const override = this._modelRuntime.getModel(provider, modelId);
			if (override && this._modelRuntime.hasConfiguredAuth(provider)) {
				return override;
			}
		}
		return this.model;
	}

	/** Resolves model and auth once per Compaction Run; `undefined` when no model is selected. */
	private async _prepareSummarizer(): Promise<Summarizer | undefined> {
		if (!this.model) return undefined;
		const {
			model: requestModel,
			apiKey,
			headers,
			env,
		} = await this._getSummarizationRequestAuth(this._summarizationModel() ?? this.model);
		return (preparation, { customInstructions, signal, reason }) =>
			this._runDefaultCompaction(
				preparation,
				requestModel,
				apiKey,
				headers,
				customInstructions,
				signal,
				env,
				reason,
			);
	}

	/** Generate Theoses's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow" | "turns",
	): Promise<CompactionResult> {
		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamFunction,
			env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which the Operation
	 * Loop (`./operation-loop.ts`) starts. Both execute the same
	 * Compaction Run (`./compaction/run.ts`); this method only maps its outcome to
	 * a result or a thrown error.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		const outcome = await this._compactionRun.run({ reason: "manual", customInstructions });
		if (outcome.kind === "completed") return outcome.result;
		throw outcome.kind === "skipped" ? new Error("Nothing to compact") : outcome.error;
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionRun.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.runSessionHooks("SessionStart", this._sessionStartEvent.reason);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPromptNow();
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._systemPrompt.options(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const nextActiveToolNames = this._tools.refresh({
			runner: this._extensionRunner,
			baseToolDefinitions: this._baseToolDefinitions,
			previousActiveToolNames: this.getActiveToolNames(),
			activeToolNames: options?.activeToolNames,
			includeAllExtensionTools: options?.includeAllExtensionTools,
			taskPlanEnabled: this.settingsManager.getTaskPlanEnabled(),
			taskToolEnabled: this.settingsManager.getTaskToolEnabled(),
		});
		this.setActiveToolsByName(nextActiveToolNames);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		// Shared with the task sub-agent, which does the parent's own work with the same tools.
		const sharedToolOptions: TaskToolOptions = {
			read: { autoResizeImages },
			bash: { commandPrefix: shellCommandPrefix, shellPath },
			edit: {
				siblingHint: this.settingsManager.getEditSiblingHint(),
				resultSnippet: this.settingsManager.getEditSnippet(),
			},
		};
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					...sharedToolOptions,
					workingNote: (note) => this.sessionManager.appendWorkingNote(note),
					workingNoteClear: () => this.sessionManager.clearWorkingNote(),
					taskPlan: {
						get: () => this.sessionManager.getTaskPlan(),
						set: (plan) => this.sessionManager.setTaskPlan(plan),
						runMessages: () => currentRunMessages(this.agent.state.messages),
					},
					memory: this._memoryStore,
				});

		// Explorer/research sub-agent tools (issues #254, #260, #263) route their provider traffic
		// through the same extension events as the main session, under their own model.
		const providerHooks = extensionProviderHooks(() => this._extensionRunner);

		// Merged into the base definitions here rather than exported through core/tools/index.ts:
		// tools/index.ts already sits in an import cycle with core/extensions/types.ts, and
		// explorer.ts needs both — re-exporting through the barrel made explorer.ts the third node
		// of that cycle, and tsgo resolved the cyclic re-export to "name not found" at use sites.
		// The direct merge keeps the cycle out.
		(baseToolDefinitions as Record<string, ToolDefinition<any>>).explore = createExploreToolDefinition({
			cwd: this._cwd,
			modelRuntime: this._modelRuntime,
			providerHooks,
		});

		// Same reason as `explore`: kept out of tools/index.ts. Inactive unless `taskTool.enabled` (tool-registry.ts).
		(baseToolDefinitions as Record<string, ToolDefinition<any>>).task = createTaskToolDefinition({
			cwd: this._cwd,
			modelRuntime: this._modelRuntime,
			getModel: () => this.model,
			getThinkingLevel: () => this.thinkingLevel,
			providerHooks,
			beforeToolCall: (context) => this._gateToolCall(context),
			afterToolCall: (context) => this._afterToolCall(context),
			toolOptions: sharedToolOptions,
		});

		// Same reason as `explore` above for living here rather than in tools/index.ts.
		(baseToolDefinitions as Record<string, ToolDefinition<any>>).research = createResearchToolDefinition({
			modelRuntime: this._modelRuntime,
			jobs: this._researchJobs,
			providerHooks,
		});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const baseActiveToolNames =
			options.activeToolNames ??
			initialActiveToolNames({
				configuredDefaultTools: this.settingsManager.getDefaultTools(),
				baseToolsOverride: this._baseToolsOverride,
			});
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await this.runSessionHooks("SessionEnd", "reload");
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this._modelRuntime.setExcludedModels(this.settingsManager.getExcludedModels());
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.runSessionHooks("SessionStart", "reload");
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source:
			| { source: "branchSummary" }
			| { source: "compaction"; reason: "manual" | "threshold" | "overflow" | "turns" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._operationLoop.cancelRetry();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._operationLoop.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		// Issue #173: mechanically record the command in the Working Note,
		// independent of whether the model itself calls working_note — a
		// harness-owned safety net so the exact path/method a later tool call
		// in this same operation needs isn't only recoverable by re-reading
		// full history (or lost entirely once compaction drops it).
		if (command.trim()) {
			const loggedCommand =
				command.length > BASH_AUTO_LOG_COMMAND_CAP ? `${command.slice(0, BASH_AUTO_LOG_COMMAND_CAP)}…` : command;
			this.sessionManager.appendWorkingNote(`ran: ${loggedCommand}`);
		}

		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this._summarizationModel() ?? this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = stripClockAnnotation(contentText(entry.message.content, ""));
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
