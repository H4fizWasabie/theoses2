import type { AgentTool } from "theoses-agent-core";
import {
	type ExtensionRunner,
	type RegisteredTool,
	type ToolDefinition,
	type ToolInfo,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { createDeferredToolDefinitions } from "./tools/deferred-dispatch.ts";

/**
 * Tool Registry (CONTEXT.md): the session's set of available tools, built from built-in, SDK, external and
 * extension sources, and the rule that decides which of them are active. It does not own the active set (the
 * Agent does): `refresh` returns the names that should be active and the caller applies them.
 */

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ToolRegistryOptions {
	/** SDK-supplied tools. */
	customTools: ToolDefinition[];
	/** Tools from an external tool source (sidecar, MCP): deferred behind tool_search unless already active. */
	externalTools: RegisteredTool[];
	/** When set, only these tools exist. They are also always active, except external ones. */
	allowedToolNames?: ReadonlySet<string>;
	excludedToolNames?: ReadonlySet<string>;
	/** The active names the session was created with; an empty list keeps the tool_search pair inactive. */
	initialActiveToolNames?: string[];
	/** Activates tools found through tool_search. The Agent stays the source of truth for the active set. */
	activate: (names: string[]) => void;
}

export interface ToolRegistryRefresh {
	/** Read once: registered extension tools, and the runner that wraps every tool's execution. */
	runner: ExtensionRunner;
	baseToolDefinitions: ReadonlyMap<string, ToolDefinition>;
	previousActiveToolNames: string[];
	/** Explicit active set; when omitted the previous one is kept and newly registered tools join it. */
	activeToolNames?: string[];
	includeAllExtensionTools?: boolean;
	/** `taskPlan.enabled: false` hides the task_plan tool itself. */
	taskPlanEnabled: boolean;
	/** `taskTool.enabled` must be on for the `task` sub-agent tool to be active. */
	taskToolEnabled: boolean;
}

export interface ToolRegistry {
	/** Rebuilds the registry and returns the tool names that should be active. */
	refresh(input: ToolRegistryRefresh): string[];
	/** Registry tools by name; unknown names are dropped. */
	resolve(names: string[]): AgentTool[];
	getAll(): ToolInfo[];
	getDefinition(name: string): ToolDefinition | undefined;
	/** One-line prompt snippets by tool name, as of the last refresh. */
	readonly promptSnippets: ReadonlyMap<string, string>;
	readonly promptGuidelines: ReadonlyMap<string, string[]>;
}

// string[], not ToolName[]: `explore`, `research` and `task` are created in agent-session.ts (they need ModelRuntime
// and would drag tools/index.ts into the extensions/types.ts import cycle), so they can't be in
// createAllToolDefinitions / the ToolName union. `task` stays inactive unless `taskTool.enabled` (see refresh).
const DEFAULT_ACTIVE_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"working_note",
	"task_plan",
	"note_operations",
	"remember",
	"save_note",
	"recall_turns",
	"convert_doc",
	"web_search",
	"generate_image",
	"explore",
	"research",
	"task",
];

export interface InitialActiveToolsInput {
	/** Explicit list (`--tools`); wins over everything but the exclude list. */
	tools?: string[];
	/** Start with nothing active. */
	noTools?: boolean | string;
	excludeTools?: string[];
	/** The `defaultTools` setting, replacing the built-in baseline when set. */
	configuredDefaultTools?: string[];
	/** Test-only: the baseline becomes exactly these tools. */
	baseToolsOverride?: Record<string, unknown>;
}

/** The active tool names a session starts with: the one place the baseline set is decided. */
export function initialActiveToolNames(input: InitialActiveToolsInput): string[] {
	const baseline = input.baseToolsOverride
		? Object.keys(input.baseToolsOverride)
		: (input.configuredDefaultTools ?? [...DEFAULT_ACTIVE_TOOL_NAMES]);
	const names = input.tools ?? (input.noTools ? [] : baseline);
	const excluded = input.excludeTools ? new Set(input.excludeTools) : undefined;
	return names.filter((name) => !excluded?.has(name));
}

function normalizePromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

function builtinEntry(definition: ToolDefinition): ToolDefinitionEntry {
	return { definition, sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }) };
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
	const { allowedToolNames, excludedToolNames } = options;
	const isAllowedTool = (name: string): boolean =>
		(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

	let tools: Map<string, AgentTool> = new Map();
	let definitions: Map<string, ToolDefinitionEntry> = new Map();
	let promptSnippets: Map<string, string> = new Map();
	let promptGuidelines: Map<string, string[]> = new Map();
	// Survives refreshes: tool_search ranks by how often each deferred tool was used this session.
	const deferredUsage = new Map<string, number>();

	function refresh(input: ToolRegistryRefresh): string[] {
		const { runner, baseToolDefinitions, previousActiveToolNames } = input;
		const previousRegistryNames = new Set(tools.keys());

		const registeredTools = runner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...options.externalTools,
			...options.customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const dispatcherDefinitions = createDeferredToolDefinitions(
			() => new Map(allCustomTools.map((tool) => [tool.definition.name, tool.definition])),
			(names, _context) => options.activate(names),
			{
				get: (name) => deferredUsage.get(name) ?? 0,
				record: (name) => deferredUsage.set(name, (deferredUsage.get(name) ?? 0) + 1),
			},
			(name, toolCallId, args, signal, onUpdate) => {
				const tool = tools.get(name);
				if (!tool) throw new Error(`Unknown deferred tool: ${name}`);
				return tool.execute(toolCallId, args, signal, onUpdate);
			},
		);
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [name, builtinEntry(definition)]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		for (const definition of dispatcherDefinitions) {
			if (!isAllowedTool(definition.name)) continue;
			definitionRegistry.set(definition.name, builtinEntry(definition));
		}
		definitions = definitionRegistry;
		promptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		promptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedDispatcherTools = wrapRegisteredTools(dispatcherDefinitions.map(builtinEntry), runner, false);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map(builtinEntry),
			runner,
			false,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedDispatcherTools) toolRegistry.set(tool.name, tool);
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		tools = toolRegistry;

		// Only tools sourced from an external tool source (#14: HTTP sidecar/MCP) default to
		// deferred/inactive (#16). Built-in, extension-registered, and SDK tools keep their
		// pre-#16 default-active behavior — #16 scoped deferral to large external catalogs,
		// not to Pi's own first-party tool registration mechanisms.
		const isExternalToolSource = (name: string): boolean => {
			const source = definitionRegistry.get(name)?.sourceInfo.source;
			return source?.startsWith("sidecar:") === true || source?.startsWith("mcp:") === true;
		};

		const nextActiveToolNames = (
			input.activeToolNames ? [...input.activeToolNames] : [...previousActiveToolNames]
		).filter(
			(name) => isAllowedTool(name) && (!isExternalToolSource(name) || previousActiveToolNames.includes(name)),
		);

		if (allowedToolNames) {
			for (const toolName of tools.keys()) {
				if (allowedToolNames.has(toolName) && !isExternalToolSource(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (input.includeAllExtensionTools) {
			for (const toolName of tools.keys()) {
				if (
					isAllowedTool(toolName) &&
					!isExternalToolSource(toolName) &&
					definitionRegistry.get(toolName)?.sourceInfo.source !== "builtin"
				) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (!input.activeToolNames) {
			for (const toolName of tools.keys()) {
				if (!previousRegistryNames.has(toolName) && isAllowedTool(toolName) && !isExternalToolSource(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Only external (MCP/sidecar) tools are ever deferred, so without one there is nothing for
		// tool_search to find and the pair only invites searches for tools that are already active.
		const hasDeferredTools = allCustomTools.some((tool) => isExternalToolSource(tool.definition.name));
		for (const dispatcherName of hasDeferredTools ? ["tool_search", "tool_call"] : []) {
			if (
				isAllowedTool(dispatcherName) &&
				input.activeToolNames?.length !== 0 &&
				options.initialActiveToolNames?.length !== 0
			) {
				nextActiveToolNames.push(dispatcherName);
			}
		}

		// taskPlan.enabled: false must hide the task_plan tool itself, not just the stop-guard
		// that used to be the only thing gated on it (the model kept "planning" into a tool
		// nothing enforced). Filtered here, after allowedToolNames/activeToolNames are merged,
		// so a caller-supplied list (e.g. --tools) can't push it back in.
		const hidden = new Set<string>();
		if (!input.taskPlanEnabled) hidden.add("task_plan");
		// Same for the task sub-agent tool: off unless the setting turns it on, whatever list the caller passed.
		if (!input.taskToolEnabled) hidden.add("task");
		return [...new Set(nextActiveToolNames.filter((name) => !hidden.has(name)))];
	}

	return {
		refresh,
		resolve(names) {
			const resolved: AgentTool[] = [];
			for (const name of names) {
				const tool = tools.get(name);
				if (tool) resolved.push(tool);
			}
			return resolved;
		},
		getAll() {
			return Array.from(definitions.values()).map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo,
			}));
		},
		getDefinition: (name) => definitions.get(name)?.definition,
		get promptSnippets() {
			return promptSnippets;
		},
		get promptGuidelines() {
			return promptGuidelines;
		},
	};
}
