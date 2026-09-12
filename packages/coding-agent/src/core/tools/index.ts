export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export { type ConvertDocInput, type ConvertDocOperations, createConvertDocToolDefinition } from "./convert-doc.ts";
export { createDeferredToolDefinitions } from "./deferred-dispatch.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGenerateImageToolDefinition,
	type GenerateImageOperations,
	type GenerateImageToolInput,
} from "./generate-image.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export { createMemoryToolDefinitions } from "./memory.ts";
export { createRecallTurnsToolDefinition } from "./recall-turns.ts";
export {
	appendOperationalNote,
	createOperationalNotesToolDefinition,
	OPERATIONAL_NOTES_MAX_BYTES,
	type OperationalNoteInput,
} from "./operational-notes.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWebSearchToolDefinition,
	type WebSearchOperations,
	type WebSearchToolInput,
} from "./web-search.ts";
export { createWorkingNoteToolDefinition, type WorkingNoteToolInput } from "./working-note.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "theoses-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { FileMemoryStore, type MemoryStore } from "../memory-store.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import type { ConvertDocOperations } from "./convert-doc.ts";
import { createConvertDocToolDefinition } from "./convert-doc.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGenerateImageToolDefinition, type GenerateImageOperations } from "./generate-image.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createMemoryToolDefinitions } from "./memory.ts";
import { createRecallTurnsToolDefinition } from "./recall-turns.ts";
import { createOperationalNotesToolDefinition } from "./operational-notes.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebSearchToolDefinition, type WebSearchOperations } from "./web-search.ts";
import { createWorkingNoteToolDefinition } from "./working-note.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "working_note"
	| "note_operations"
	| "remember"
	| "save_note"
	| "recall_turns"
	| "convert_doc"
	| "web_search"
	| "generate_image";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"working_note",
	"note_operations",
	"remember",
	"save_note",
	"recall_turns",
	"convert_doc",
	"web_search",
	"generate_image",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	workingNote?: (note: string) => void;
	workingNoteClear?: () => void;
	operationalNotes?: { path?: string };
	memory?: MemoryStore;
	onMemorySaved?: () => void;
	convertDoc?: { operations?: ConvertDocOperations };
	webSearch?: { operations?: WebSearchOperations; apiKeys?: string[] };
	generateImage?: { operations?: GenerateImageOperations };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "working_note":
			return createWorkingNoteToolDefinition(
				options?.workingNote ?? (() => {}),
				options?.workingNoteClear ?? (() => {}),
			);
		case "note_operations":
			return createOperationalNotesToolDefinition(options?.operationalNotes);
		case "remember":
		case "save_note": {
			const definitions = createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore());
			return definitions.find((definition) => definition.name === toolName)!;
		}
		case "recall_turns":
			return createRecallTurnsToolDefinition();
		case "convert_doc":
			return createConvertDocToolDefinition(cwd, options?.convertDoc);
		case "web_search":
			return createWebSearchToolDefinition(options?.webSearch);
		case "generate_image":
			return createGenerateImageToolDefinition(options?.generateImage);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "working_note":
			return wrapToolDefinition(
				createWorkingNoteToolDefinition(
					options?.workingNote ?? (() => {}),
					options?.workingNoteClear ?? (() => {}),
				),
			);
		case "note_operations":
			return wrapToolDefinition(createOperationalNotesToolDefinition(options?.operationalNotes));
		case "remember":
		case "save_note": {
			const definitions = createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore());
			return wrapToolDefinition(definitions.find((definition) => definition.name === toolName)!);
		}
		case "recall_turns":
			return wrapToolDefinition(createRecallTurnsToolDefinition());
		case "convert_doc":
			return wrapToolDefinition(createConvertDocToolDefinition(cwd, options?.convertDoc));
		case "web_search":
			return wrapToolDefinition(createWebSearchToolDefinition(options?.webSearch));
		case "generate_image":
			return wrapToolDefinition(createGenerateImageToolDefinition(options?.generateImage));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createConvertDocToolDefinition(cwd, options?.convertDoc),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createConvertDocToolDefinition(cwd, options?.convertDoc),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		working_note: createWorkingNoteToolDefinition(
			options?.workingNote ?? (() => {}),
			options?.workingNoteClear ?? (() => {}),
		),
		note_operations: createOperationalNotesToolDefinition(options?.operationalNotes),
		remember: createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore(), options?.onMemorySaved)[0]!,
		save_note: createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore(), options?.onMemorySaved)[1]!,
		recall_turns: createRecallTurnsToolDefinition(),
		convert_doc: createConvertDocToolDefinition(cwd, options?.convertDoc),
		web_search: createWebSearchToolDefinition(options?.webSearch),
		generate_image: createGenerateImageToolDefinition(options?.generateImage),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		wrapToolDefinition(createConvertDocToolDefinition(cwd, options?.convertDoc)),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		wrapToolDefinition(createConvertDocToolDefinition(cwd, options?.convertDoc)),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		working_note: wrapToolDefinition(
			createWorkingNoteToolDefinition(options?.workingNote ?? (() => {}), options?.workingNoteClear ?? (() => {})),
		),
		note_operations: wrapToolDefinition(createOperationalNotesToolDefinition(options?.operationalNotes)),
		remember: wrapToolDefinition(createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore())[0]!),
		save_note: wrapToolDefinition(createMemoryToolDefinitions(options?.memory ?? new FileMemoryStore())[1]!),
		recall_turns: wrapToolDefinition(createRecallTurnsToolDefinition()),
		convert_doc: wrapToolDefinition(createConvertDocToolDefinition(cwd, options?.convertDoc)),
		web_search: wrapToolDefinition(createWebSearchToolDefinition(options?.webSearch)),
		generate_image: wrapToolDefinition(createGenerateImageToolDefinition(options?.generateImage)),
	};
}
