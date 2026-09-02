import type { AgentToolResult, AgentToolUpdateCallback } from "theoses-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const searchSchema = Type.Object({ query: Type.String({ description: "What kind of tool or action you need" }) });
const callSchema = Type.Object({
	name: Type.String({ description: "Exact tool name returned by tool_search" }),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type SearchInput = Static<typeof searchSchema>;
type CallInput = Static<typeof callSchema>;

type ToolLookup = () => ReadonlyMap<string, ToolDefinition>;
type ToolActivation = (names: string[], context: ExtensionContext) => void;
type ToolUsage = { get: (name: string) => number; record: (name: string) => void };
type ToolExecution = (
	name: string,
	toolCallId: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) => Promise<AgentToolResult<unknown>>;

function matchesTool(query: string, tool: ToolDefinition): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = `${tool.name} ${tool.description}`.toLowerCase();
	return terms.some((term) => haystack.includes(term));
}

const FREQUENCY_PROMOTION_THRESHOLD = 3;

function matchingTools(query: string, tools: ReadonlyMap<string, ToolDefinition>, usage: ToolUsage): ToolDefinition[] {
	return [...tools.values()]
		.filter((tool) => matchesTool(query, tool))
		.sort(
			(a, b) =>
				Number(usage.get(b.name) >= FREQUENCY_PROMOTION_THRESHOLD) -
					Number(usage.get(a.name) >= FREQUENCY_PROMOTION_THRESHOLD) ||
				usage.get(b.name) - usage.get(a.name) ||
				a.name.localeCompare(b.name),
		);
}

function toolSearchResult(query: string, tools: ReadonlyMap<string, ToolDefinition>, usage: ToolUsage): string {
	const matches = matchingTools(query, tools, usage)
		.slice(0, 20)
		.map((tool) => ({ name: tool.name, description: tool.description }));
	return JSON.stringify(matches);
}

export function createDeferredToolDefinitions(
	lookup: ToolLookup,
	activate: ToolActivation,
	usage: ToolUsage,
	execute: ToolExecution,
): ToolDefinition[] {
	return [
		{
			name: "tool_search",
			label: "tool_search",
			description: "Find deferred tools by name or capability. Matching tools become available for this session.",
			promptSnippet: "Find deferred tools by capability",
			parameters: searchSchema,
			execute: async (_id, { query }: SearchInput, _signal, _onUpdate, context) => {
				const tools = lookup();
				const names = matchingTools(query, tools, usage)
					.slice(0, 20)
					.map((tool) => tool.name);
				activate(names, context);
				return { content: [{ type: "text", text: toolSearchResult(query, tools, usage) }], details: undefined };
			},
		},
		{
			name: "tool_call",
			label: "tool_call",
			description: "Call a deferred tool by exact name after finding it with tool_search.",
			promptSnippet: "Call a discovered deferred tool",
			parameters: callSchema,
			execute: async (
				toolCallId: string,
				{ name, args }: CallInput,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<unknown> | undefined,
				_context: ExtensionContext,
			) => {
				const target = lookup().get(name);
				if (!target || name === "tool_search" || name === "tool_call") {
					throw new Error(`Unknown deferred tool: ${name}`);
				}
				usage.record(name);
				return execute(name, toolCallId, args ?? {}, signal, onUpdate);
			},
		},
	];
}
