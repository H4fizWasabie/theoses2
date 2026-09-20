export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

/** Diagnostic type recorded when a turn ends with `stop`, no tool call and far more output tokens than visible text. */
export const STOP_WITHOUT_TOOL_CALL_DIAGNOSTIC = "stop_without_tool_call_hidden_output";

const HIDDEN_OUTPUT_MIN_TOKENS = 150;
/** Rough characters per token; only used to size the visible text against the billed output tokens. */
const CHARS_PER_TOKEN = 3.5;

/**
 * True when a turn ended with `stop`, carried no tool call, yet billed far more output tokens than its visible
 * text can account for. Seen on 2026-09-20: Relace billed 509 tokens for a 145-character "Now the collector: ..."
 * message, the tool call the model was writing never arrived, and the task sat idle until the user typed
 * "Proceed". Reasoning tokens are counted separately by the caller and excluded here.
 */
export function isStopWithHiddenOutput(input: {
	stopReason: string;
	toolCallCount: number;
	outputTokens: number;
	reasoningTokens: number;
	visibleChars: number;
}): boolean {
	if (input.stopReason !== "stop" || input.toolCallCount > 0) return false;
	const unexplained = input.outputTokens - input.reasoningTokens;
	return (
		unexplained > HIDDEN_OUTPUT_MIN_TOKENS &&
		unexplained > 4 * (input.visibleChars / CHARS_PER_TOKEN) + HIDDEN_OUTPUT_MIN_TOKENS
	);
}

/** One short line per stream chunk (delta keys, finish_reason, sizes) for the tail kept in a diagnostic. Never keeps message text. */
export function summarizeStreamChunk(chunk: unknown): string {
	const c = chunk as {
		choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[];
		usage?: { completion_tokens?: unknown };
	};
	const choice = c?.choices?.[0];
	const delta = choice?.delta ?? {};
	const sizes = Object.entries(delta)
		.filter(([, v]) => v !== null && v !== undefined && v !== "")
		.map(([k, v]) => `${k}:${typeof v === "string" ? v.length : Array.isArray(v) ? `${v.length}items` : typeof v}`);
	const finish = choice?.finish_reason ? ` finish=${String(choice.finish_reason)}` : "";
	const usage =
		c?.usage?.completion_tokens !== undefined ? ` completion_tokens=${String(c.usage.completion_tokens)}` : "";
	return `{${sizes.join(",")}}${finish}${usage}`;
}
