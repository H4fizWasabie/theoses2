import { afterEach, describe, expect, it, vi } from "vitest";
import { askJevNoul, askJevNouls } from "../src/core/jev-client.ts";

describe("askJevNoul timeout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("aborts a stalled request and resolves undefined instead of hanging", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				signal = init.signal ?? undefined;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal?.reason));
				});
			}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20 });

		expect(result).toBeUndefined();
		expect(signal?.aborted).toBe(true);
	});

	it("names the call site, elapsed time, timeout and state size in the failure log", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				const signal = init.signal;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal?.reason));
				});
			}),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20, label: "memory-gate" });

		const logged = String(errorSpy.mock.calls.at(-1)?.[0]);
		expect(logged).toContain("Jev call failed [memory-gate] after ");
		expect(logged).toContain("(timeout 20ms, questions=answer, state=16 chars)");
	});

	it("sends a fresh request after a timeout when the caller asks for a retry", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					}),
			)
			.mockImplementationOnce(async () => new Response(JSON.stringify({ answers: { answer: { noul: 0.7 } } })));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20, retries: 1 })).toBe(0.7);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(errorSpy.mock.calls[0]?.[0])).toContain("timeout 20ms");
	});

	it("does not retry without the option, or after an error that is not a timeout", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.spyOn(console, "error").mockImplementation(() => {});
		const stalled = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		vi.stubGlobal("fetch", stalled);
		expect(await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20 })).toBeUndefined();
		expect(stalled).toHaveBeenCalledTimes(1);

		const refused = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		vi.stubGlobal("fetch", refused);
		expect(await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20, retries: 1 })).toBeUndefined();
		expect(refused).toHaveBeenCalledTimes(1);

		// An HTTP failure whose body read then times out is still an HTTP failure.
		const httpError = vi.fn(async () => ({
			ok: false,
			status: 502,
			text: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
		}));
		vi.stubGlobal("fetch", httpError);
		expect(await askJevNoul({ message: "hi" }, "q", { timeoutMs: 20, retries: 1 })).toBeUndefined();
		expect(httpError).toHaveBeenCalledTimes(1);
	});

	it("passes a default timeout signal when none is given", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answers: { answer: { noul: 0.7 } } })));
		vi.stubGlobal("fetch", fetchMock);

		expect(await askJevNoul({ message: "hi" }, "q")).toBe(0.7);
		const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("askJevNouls", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("sends every question in one request and returns each probability by name", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.1 } } }),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await askJevNouls({ message: "hi" }, { a: "first?", b: "second?" });

		expect(result).toEqual({ a: 0.9, b: 0.1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
		expect(body.questions).toEqual({
			a: { type: "noul", instructions: "first?" },
			b: { type: "noul", instructions: "second?" },
		});
	});

	it("returns undefined when any requested answer is missing rather than a partial verdict", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ answers: { a: { type: "noul", noul: 0.9 } } }))),
		);

		expect(await askJevNouls({ message: "hi" }, { a: "first?", b: "second?" })).toBeUndefined();
	});
});
