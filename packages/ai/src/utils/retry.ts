import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// OpenRouter's generic finish_reason "error", seen when a model corrupts its
	// own tool-call output mid-generation (garbled pseudo-XML instead of a real
	// tool_calls block) rather than a transport-level failure (#341). Retrying
	// re-sends the same context and asks the model again, which recovers cleanly
	// since this is model flakiness, not a persistent state problem.
	"finish_reason: error",

	// theoses's own stream-duration watchdog (openai-completions.ts), not a provider
	// error: fires when a model keeps trickling tokens (often stuck rambling inside
	// its own reasoning/thinking) for minutes without ever finishing the turn. Model
	// flakiness, not a persistent state problem, and the error text itself already
	// says "Retry" - it just wasn't wired into this classifier.
	"stream exceeded the \\d+s max duration",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/** One scheduled retry, as reported before its backoff sleep. */
export interface RetrySchedule {
	/** 1-indexed. */
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** How a run of retries ended; reported once per run. */
export interface RetryEnd {
	success: boolean;
	attempt: number;
	finalError?: string;
}

/**
 * The retry state of one caller: attempt count, backoff and a cancellable sleep. Callers classify errors
 * themselves and report events; the budget guarantees one backoff formula and one end per run of retries.
 * `getPolicy` is read on every check, so a settings change applies to the next decision.
 */
export function createRetryBudget(getPolicy: () => RetryPolicy | undefined) {
	let attempt = 0;
	let sleeping: AbortController | undefined;
	const maxAttempts = () => {
		const policy = getPolicy();
		return policy?.enabled ? policy.maxRetries : 0;
	};
	return {
		/** Retries scheduled in the current run (0 when not retrying). */
		get attempt(): number {
			return attempt;
		},
		/** True while a backoff sleep is in progress. */
		get isSleeping(): boolean {
			return sleeping !== undefined;
		},
		/** True when no retry is left, including when the policy is missing or disabled. */
		get exhausted(): boolean {
			return attempt >= maxAttempts();
		},
		/** Counts the next attempt and returns its schedule. */
		next(failed: AssistantMessage): RetrySchedule {
			attempt++;
			return {
				attempt,
				maxAttempts: maxAttempts(),
				delayMs: (getPolicy()?.baseDelayMs ?? 0) * 2 ** (attempt - 1),
				errorMessage: failed.errorMessage || "Unknown error",
			};
		},
		/** Sleeps `delayMs`; false if `signal` or `cancel()` interrupted it. */
		async sleep(delayMs: number, signal?: AbortSignal): Promise<boolean> {
			sleeping = new AbortController();
			try {
				await sleep(delayMs, signal ? AbortSignal.any([signal, sleeping.signal]) : sleeping.signal);
				return true;
			} catch (error) {
				if (error instanceof RetrySleepAbortError) return false;
				throw error;
			} finally {
				sleeping = undefined;
			}
		},
		/** Interrupts the current backoff sleep, if any. */
		cancel(): void {
			sleeping?.abort();
		},
		/** Ends the current run: its end report (undefined when nothing was retried), and resets the count. */
		finish(success: boolean, finalError?: string): RetryEnd | undefined {
			if (attempt === 0) return undefined;
			const end: RetryEnd = finalError === undefined ? { success, attempt } : { success, attempt, finalError };
			attempt = 0;
			return end;
		},
	};
}

export type RetryBudget = ReturnType<typeof createRetryBudget>;

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const budget = createRetryBudget(() => policy);
	const finish = async (success: boolean, finalError?: string) => {
		const end = budget.finish(success, finalError);
		if (!end) return;
		if (end.finalError === undefined) await callbacks?.onRetryFinished?.(end.success, end.attempt);
		else await callbacks?.onRetryFinished?.(end.success, end.attempt, end.finalError);
	};
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			await finish(false);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			await finish(true);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (budget.exhausted || !isRetryableAssistantError(response)) {
			await finish(false, response.errorMessage);
			return response;
		}

		const retry = budget.next(response);
		await callbacks?.onRetryScheduled?.(retry.attempt, retry.maxAttempts, retry.delayMs, retry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		if (!(await budget.sleep(retry.delayMs, signal))) {
			await finish(false, retry.errorMessage);
			return { ...response, stopReason: "aborted", errorMessage: undefined };
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return isRetryableProviderError(message.errorMessage);
}

/** Shared classification for raw HTTP/transport failures and failed assistant messages. */
export function isRetryableProviderError(errorMessage: string, status?: number): boolean {
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(`${status ?? ""} ${errorMessage}`);
}
