import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { getModel } from "../src/compat.ts";

afterEach(() => vi.useRealTimers());

describe("Codex HTTP retry classification", () => {
	it.each([
		[401, "Invalid API key", 1],
		[402, "insufficient_quota", 1],
		[500, "billing account exhausted", 1],
		[429, "quota exceeded", 1],
		[503, "Service unavailable", 2],
		[400, "Please retry your request", 2],
		[524, "Upstream timed out", 2],
	] as const)("classifies %s %s before retrying", async (status, message, expectedCalls) => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message } }), { status, headers: { "retry-after-ms": "0" } }),
			)
			.mockImplementation(
				async () =>
					new Response(
						`data: ${JSON.stringify({
							type: "response.completed",
							response: {
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
							},
						})}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			);
		const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.test`;
		const result = stream(
			getModel("openai-codex", "gpt-5.4"),
			{ messages: [] },
			{
				apiKey: token,
				transport: "sse",
				maxRetries: 1,
				fetch,
			},
		).result();
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe(expectedCalls === 1 ? "error" : "stop");
		expect(fetch).toHaveBeenCalledTimes(expectedCalls);
	});
});
