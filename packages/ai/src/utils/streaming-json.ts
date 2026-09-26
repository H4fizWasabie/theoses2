import { parseCompleteJson, parseStreamingJson } from "./json-parse.ts";

/**
 * Re-parsing the whole accumulated tool-call argument buffer from scratch on every
 * streaming delta is O(length) per call, so for a large argument streamed in many
 * small deltas the total cost is O(length^2), which pegs the event loop. The live
 * "partial" preview doesn't need every single token, so throttle re-parses once the
 * buffer is non-trivial.
 */
export const STREAMING_ARGS_REPARSE_THROTTLE_CHARS = 2000;

/**
 * Accumulates a streaming tool-call argument buffer and throttles re-parsing it
 * into a live preview. Create one per tool call at toolcall-start time and keep it
 * in the adapter's own per-block/slot bookkeeping (a Map or WeakMap keyed by the
 * output block, never a field on the block itself, so nothing needs to be stripped
 * from the persisted ToolCall before replay).
 */
export class StreamingJsonAccumulator {
	private text = "";
	private lastParsedLength = 0;
	private preview: Record<string, unknown> = {};

	/** The raw buffer accumulated so far, e.g. for a provider's own delta-vs-full-text diffing. */
	get buffer(): string {
		return this.text;
	}

	/** Append a delta and return a throttled live preview parse of the buffer so far. */
	append<T = Record<string, unknown>>(delta: string): T {
		this.text += delta;
		if (
			this.lastParsedLength === 0 ||
			this.text.length - this.lastParsedLength >= STREAMING_ARGS_REPARSE_THROTTLE_CHARS
		) {
			this.preview = parseStreamingJson<Record<string, unknown>>(this.text);
			this.lastParsedLength = this.text.length;
		}
		return this.preview as T;
	}

	/**
	 * Strictly parse the final arguments. `overrideText`, when given, replaces the
	 * accumulated buffer first: some providers' terminal events carry the full argument
	 * text directly (e.g. OpenAI Responses' `response.function_call_arguments.done`).
	 */
	finish<T = Record<string, unknown>>(overrideText?: string): T {
		if (overrideText !== undefined) this.text = overrideText;
		return parseCompleteJson<T>(this.text);
	}
}
