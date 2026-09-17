import type { TextContent } from "theoses-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 300;

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The web search query" }),
	timeout_seconds: Type.Optional(
		Type.Number({
			description:
				`Abort the search if it hasn't responded within this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}, ` +
				`min ${MIN_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}). Raise it if a previous call timed out on a slow source.`,
			minimum: MIN_TIMEOUT_SECONDS,
			maximum: MAX_TIMEOUT_SECONDS,
		}),
	),
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
			{ query, timeout_seconds }: WebSearchToolInput,
			signal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			if (apiKeys.length === 0) {
				throw new Error("web_search requires TAVILY_API_KEY (and optionally TAVILY_API_KEY_2) to be set");
			}
			const timeoutMs = (timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			let response: TavilyResponse;
			try {
				response = await operations.search(query, combinedSignal);
			} catch (error) {
				if (timeoutSignal.aborted) {
					throw new Error(
						`web_search timed out after ${timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS}s. ` +
							`Retry with a higher timeout_seconds (up to ${MAX_TIMEOUT_SECONDS}) if the source is just slow.`,
					);
				}
				throw error;
			}
			return { content: [{ type: "text", text: formatResults(response) }], details: undefined };
		},
	};
}
