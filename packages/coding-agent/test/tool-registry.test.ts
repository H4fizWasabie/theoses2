import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionRunner, RegisteredTool, ToolDefinition } from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	createToolRegistry,
	initialActiveToolNames,
	type ToolRegistryOptions,
	type ToolRegistryRefresh,
} from "../src/core/tool-registry.ts";

describe("initialActiveToolNames", () => {
	const baseline = initialActiveToolNames({});

	it("baseline includes the sub-agent tools", () => {
		expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "explore", "research", "task"]));
	});

	it.each([
		["noTools", { noTools: true }, []],
		["noTools all", { noTools: "all" }, []],
		["tools list", { tools: ["read"] }, ["read"]],
		["tools list minus excludes", { tools: ["read", "bash"], excludeTools: ["bash"] }, ["read"]],
		["configured default", { configuredDefaultTools: ["grep", "find"] }, ["grep", "find"]],
		[
			"configured default minus excludes",
			{ configuredDefaultTools: ["grep", "find"], excludeTools: ["find"] },
			["grep"],
		],
		["base tools override", { baseToolsOverride: { dummy: 1 } }, ["dummy"]],
		["tools list beats configured default", { tools: ["read"], configuredDefaultTools: ["grep"] }, ["read"]],
	])("%s", (_name, input, expected) => {
		expect(initialActiveToolNames(input)).toEqual(expected);
	});

	it("excludes apply to the baseline", () => {
		expect(initialActiveToolNames({ excludeTools: ["bash"] })).toEqual(baseline.filter((name) => name !== "bash"));
	});
});

function definition(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
		...extra,
	};
}

function registered(name: string, source: string): RegisteredTool {
	return { definition: definition(name), sourceInfo: createSyntheticSourceInfo(`<test:${name}>`, { source }) };
}

/** The registry calls getAllRegisteredTools() during a refresh; wrapped tools use the other two when executed. */
function runnerWith(...tools: RegisteredTool[]): ExtensionRunner {
	return {
		getAllRegisteredTools: () => tools,
		getActiveTools: () => [],
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
}

function base(...names: string[]): Map<string, ToolDefinition> {
	return new Map(names.map((name) => [name, definition(name)]));
}

function setup(options: Partial<ToolRegistryOptions> = {}) {
	const activated: string[][] = [];
	const registry = createToolRegistry({
		customTools: [],
		externalTools: [],
		activate: (names) => activated.push(names),
		...options,
	});
	const refresh = (input: Partial<ToolRegistryRefresh> & { baseToolDefinitions: Map<string, ToolDefinition> }) =>
		registry.refresh({
			runner: runnerWith(),
			previousActiveToolNames: [],
			taskPlanEnabled: true,
			taskToolEnabled: false,
			...input,
		});
	return { registry, refresh, activated };
}

describe("ToolRegistry", () => {
	it("keeps an explicit active set and drops excluded tools from registry and active set", () => {
		const { registry, refresh } = setup({ excludedToolNames: new Set(["bash"]) });

		const active = refresh({ baseToolDefinitions: base("read", "bash"), activeToolNames: ["read", "bash"] });

		expect(active).toEqual(["read"]);
		expect(registry.getDefinition("bash")).toBeUndefined();
		expect(registry.resolve(["bash"])).toEqual([]);
		expect(registry.resolve(["read", "nope"]).map((tool) => tool.name)).toEqual(["read"]);
	});

	it("activates exactly the allowed tools, never external ones", () => {
		const { refresh } = setup({
			allowedToolNames: new Set(["read", "ext_a", "sidecar_tool"]),
			externalTools: [registered("sidecar_tool", "sidecar:test")],
		});

		const active = refresh({
			runner: runnerWith(registered("ext_a", "extension")),
			baseToolDefinitions: base("read", "bash"),
			activeToolNames: ["read"],
		});

		expect(active).toEqual(["read", "ext_a"]);
	});

	it("joins newly registered tools when no explicit active set is given", () => {
		const { refresh } = setup();
		refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] });

		const active = refresh({
			runner: runnerWith(registered("ext_b", "extension")),
			baseToolDefinitions: base("read"),
			previousActiveToolNames: ["read"],
		});

		expect(active).toEqual(["read", "ext_b"]);
	});

	it("includeAllExtensionTools adds extension and SDK tools but not built-ins", () => {
		const { refresh } = setup({ customTools: [definition("sdk_a")] });

		const active = refresh({
			runner: runnerWith(registered("ext_a", "extension")),
			baseToolDefinitions: base("read", "bash"),
			activeToolNames: ["read"],
			includeAllExtensionTools: true,
		});

		expect(active).toEqual(["read", "ext_a", "sdk_a"]);
	});

	it("defers external tools and adds the tool_search pair only when one exists", () => {
		const external = registered("mcp_tool", "mcp:test");
		const withExternal = setup({ externalTools: [external] });
		const without = setup();

		expect(withExternal.refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] })).toEqual([
			"read",
			"tool_search",
			"tool_call",
		]);
		expect(without.refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] })).toEqual(["read"]);
	});

	it("keeps an external tool active once it was already active", () => {
		const { refresh } = setup({ externalTools: [registered("mcp_tool", "mcp:test")] });

		const active = refresh({
			baseToolDefinitions: base("read"),
			previousActiveToolNames: ["read", "mcp_tool"],
			activeToolNames: ["read", "mcp_tool"],
		});

		expect(active).toEqual(["read", "mcp_tool", "tool_search", "tool_call"]);
	});

	it("leaves the tool_search pair inactive when the session starts with no tools", () => {
		const emptyStart = setup({
			externalTools: [registered("mcp_tool", "mcp:test")],
			initialActiveToolNames: [],
		});
		const emptyExplicit = setup({ externalTools: [registered("mcp_tool", "mcp:test")] });

		expect(emptyStart.refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] })).toEqual(["read"]);
		expect(emptyExplicit.refresh({ baseToolDefinitions: base("read"), activeToolNames: [] })).toEqual([]);
	});

	it("hides task_plan when taskPlan is disabled, even from an explicit list", () => {
		const { refresh } = setup();
		const baseTools = base("read", "task_plan");

		expect(refresh({ baseToolDefinitions: baseTools, activeToolNames: ["read", "task_plan"] })).toEqual([
			"read",
			"task_plan",
		]);
		expect(
			refresh({ baseToolDefinitions: baseTools, activeToolNames: ["read", "task_plan"], taskPlanEnabled: false }),
		).toEqual(["read"]);
	});

	it("hides the task tool unless taskTool is enabled, even from an explicit list", () => {
		const { refresh } = setup();
		const baseTools = base("read", "task");

		expect(refresh({ baseToolDefinitions: baseTools, activeToolNames: ["read", "task"] })).toEqual(["read"]);
		expect(
			refresh({ baseToolDefinitions: baseTools, activeToolNames: ["read", "task"], taskToolEnabled: true }),
		).toEqual(["read", "task"]);
	});

	it("lists tools with source info and normalizes prompt snippets and guidelines", () => {
		const { registry, refresh } = setup({ customTools: [definition("sdk_a")] });
		const documented = definition("documented", {
			promptSnippet: "  first line\n second   line ",
			promptGuidelines: [" a ", "a", "", "b"],
		});

		refresh({ baseToolDefinitions: new Map([["documented", documented]]), activeToolNames: ["documented"] });

		expect(registry.getAll().map((tool) => [tool.name, tool.sourceInfo.source])).toEqual([
			["documented", "builtin"],
			["sdk_a", "sdk"],
			["tool_search", "builtin"],
			["tool_call", "builtin"],
		]);
		expect(registry.promptSnippets.get("documented")).toBe("first line second line");
		expect(registry.promptGuidelines.get("documented")).toEqual(["a", "b"]);
	});

	it("hands tools found by tool_search to the injected activation callback", async () => {
		const { registry, refresh, activated } = setup({ externalTools: [registered("mcp_tool", "mcp:test")] });
		refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] });

		const [toolSearch] = registry.resolve(["tool_search"]);
		await toolSearch.execute("call-1", { query: "mcp" }, undefined, undefined);

		expect(activated).toEqual([["mcp_tool"]]);
	});

	it("executes a deferred tool through tool_call from the registry", async () => {
		const { registry, refresh } = setup({ externalTools: [registered("mcp_tool", "mcp:test")] });
		refresh({ baseToolDefinitions: base("read"), activeToolNames: ["read"] });

		const [toolCall] = registry.resolve(["tool_call"]);
		const result = await toolCall.execute("call-2", { name: "mcp_tool", args: {} }, undefined, undefined);

		expect(result.content).toEqual([{ type: "text", text: "mcp_tool" }]);
		await expect(toolCall.execute("call-3", { name: "nope" }, undefined, undefined)).rejects.toThrow(
			"Unknown deferred tool: nope",
		);
	});
});
