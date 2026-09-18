import { afterEach, describe, expect, it, vi } from "vitest";
import { askJevNoul } from "../src/core/jev-client.ts";

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

	it("passes a default timeout signal when none is given", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answers: { answer: { noul: 0.7 } } })));
		vi.stubGlobal("fetch", fetchMock);

		expect(await askJevNoul({ message: "hi" }, "q")).toBe(0.7);
		const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});
