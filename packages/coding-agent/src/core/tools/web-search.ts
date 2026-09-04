import type { TextContent } from "theoses-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The web search query" }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

interface TavilyResult {
	title: string;
	url: string;
	content: string;
}

interface TavilyResponse {
	answer?: string;
	results: TavilyResult[];
}

export interface WebSearchOperations {
	search: (query: string, signal?: AbortSignal) => Promise<TavilyResponse>;
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

async function tavilySearch(apiKey: string, query: string, signal?: AbortSignal): Promise<TavilyResponse> {
	const response = await fetch(TAVILY_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ query, max_results: 5 }),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Tavily request failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as TavilyResponse;
}

/** Tries each key in order, falling back to the next on failure (rate limit, exhausted credits, outage). */
function createTavilyOperations(apiKeys: string[]): WebSearchOperations {
	return {
		search: async (query, signal) => {
			let lastError: unknown;
			for (const apiKey of apiKeys) {
				try {
					return await tavilySearch(apiKey, query, signal);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error ? lastError : new Error(String(lastError));
		},
	};
}

function formatResults(response: TavilyResponse): string {
	const parts: string[] = [];
	if (response.answer) parts.push(response.answer);
	for (const result of response.results) {
		parts.push(`${result.title}\n${result.url}\n${result.content}`);
	}
	return parts.length > 0 ? parts.join("\n\n") : "No results found.";
}

export function createWebSearchToolDefinition(options?: {
	operations?: WebSearchOperations;
	apiKeys?: string[];
}): ToolDefinition<typeof webSearchSchema, undefined> {
	const apiKeys = (options?.apiKeys ?? [process.env.TAVILY_API_KEY, process.env.TAVILY_API_KEY_2]).filter(
		(key): key is string => !!key,
	);
	const operations = options?.operations ?? createTavilyOperations(apiKeys);

	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web for current information via Tavily. Returns an answer summary and source links.",
		promptSnippet: "Search the web for current information",
		parameters: webSearchSchema,
		execute: async (
			_id,
			{ query }: WebSearchToolInput,
			signal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			if (apiKeys.length === 0) {
				throw new Error("web_search requires TAVILY_API_KEY (and optionally TAVILY_API_KEY_2) to be set");
			}
			const response = await operations.search(query, signal);
			return { content: [{ type: "text", text: formatResults(response) }], details: undefined };
		},
	};
}
