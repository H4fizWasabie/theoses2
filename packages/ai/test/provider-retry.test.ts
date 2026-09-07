import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseRetryAfterHeaderMs,
	RetryDelayExceededError,
	retryProviderRequest,
	validateServerRetryDelayMs,
} from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

// Codex's raw-fetch retry loop (api/openai-codex-responses.ts) shares these two
// helpers instead of maintaining its own copy, so the header-parsing and delay-cap
// rules can't silently drift between the two providers. Covered directly here since
// the codex stream tests only exercise them indirectly through a full request.
describe("shared retry-after helpers", () => {
	it("prefers retry-after-ms over retry-after, clamped to zero", () => {
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after-ms": "1500", "retry-after": "9999" }))).toBe(1500);
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after-ms": "-50" }))).toBe(0);
	});

	it("falls back to retry-after seconds or an HTTP-date, clamped to zero", () => {
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "2" }))).toBe(2000);
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }))).toBe(
			0,
		);
	});

	it("returns undefined when neither header is present or parseable", () => {
		expect(parseRetryAfterHeaderMs(new Headers())).toBeUndefined();
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "not-a-delay" }))).toBeUndefined();
	});

	it("throws RetryDelayExceededError once the cap is exceeded", () => {
		expect(() => validateServerRetryDelayMs(2000, 1000)).toThrow(RetryDelayExceededError);
		expect(() => validateServerRetryDelayMs(2000, 1000)).toThrow("Server requested 2s retry delay (max: 1s)");
		expect(validateServerRetryDelayMs(500, 1000)).toBe(500);
	});
});
