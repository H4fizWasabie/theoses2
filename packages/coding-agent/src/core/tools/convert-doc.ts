import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { TextContent } from "theoses-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";

const execFileAsync = promisify(execFile);
const convertDocSchema = Type.Object({
	path: Type.String({ description: "Path to a document file (relative or absolute)" }),
});

export type ConvertDocInput = Static<typeof convertDocSchema>;

export interface ConvertDocOperations {
	convert: (path: string, signal?: AbortSignal) => Promise<string>;
}

const defaultOperations: ConvertDocOperations = {
	convert: async (path, signal) => {
		try {
			const result = await execFileAsync("markitdown", [path], { maxBuffer: 2_000_000, signal });
			return result.stdout;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("ENOENT")) {
				throw new Error("markitdown is not installed; install the markitdown CLI before using convert_doc");
			}
			throw new Error(message);
		}
	},
};

export function createConvertDocToolDefinition(
	cwd: string,
	options?: { operations?: ConvertDocOperations },
): ToolDefinition<typeof convertDocSchema, undefined> {
	const operations = options?.operations ?? defaultOperations;
	return {
		name: "convert_doc",
		label: "convert_doc",
		description:
			"Convert a document to Markdown using Microsoft markitdown. Supports common document formats including docx, pdf, xlsx, pptx, html, csv, and json. Use the artifact path from the session catalog or a local file path.",
		promptSnippet: "Convert document files to Markdown",
		parameters: convertDocSchema,
		execute: async (
			_id,
			{ path }: ConvertDocInput,
			signal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const absolutePath = await resolveReadPathAsync(path, cwd);
			await access(absolutePath);
			const text = (await operations.convert(absolutePath, signal)).trim();
			return {
				content: [{ type: "text", text: text || "The document contained no extractable text." }],
				details: undefined,
			};
		},
	};
}
