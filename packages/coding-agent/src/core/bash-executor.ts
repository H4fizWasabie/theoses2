/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated to head and tail) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const output = new OutputAccumulator({ tempFilePrefix: "theoses-bash" });
	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
		output.append(Buffer.from(text, "utf-8"));
		options?.onChunk?.(text);
	};

	const finish = async () => {
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		return snapshot;
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});
		const snapshot = await finish();
		const cancelled = options?.signal?.aborted ?? false;
		return {
			output: snapshot.content,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: snapshot.truncation.truncated,
			fullOutputPath: snapshot.fullOutputPath,
		};
	} catch (err) {
		const snapshot = await finish();
		// Check if it was an abort
		if (options?.signal?.aborted) {
			return {
				output: snapshot.content,
				exitCode: undefined,
				cancelled: true,
				truncated: snapshot.truncation.truncated,
				fullOutputPath: snapshot.fullOutputPath,
			};
		}
		throw err;
	}
}
