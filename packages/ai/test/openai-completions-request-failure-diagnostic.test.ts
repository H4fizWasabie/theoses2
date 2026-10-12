import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import type { Context, FetchFunction, Model } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://upstream.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

// Headers arrive, one chunk streams, then the connection dies the way undici reports it.
const dropMidStream: FetchFunction = async () => {
	const chunk = `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`;
	let sent = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(new TextEncoder().encode(chunk));
				return;
			}
			const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
			controller.error(new TypeError("terminated", { cause }));
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

describe("openai-completions request failure diagnostic", () => {
	it("records the error, its cause and when headers arrived", async () => {
		const message = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: dropMidStream,
			maxRetries: 0,
		}).result();

		expect(message.stopReason).toBe("error");
		const diagnostic = message.diagnostics?.find((d) => d.type === "provider_request_failure");
		expect(diagnostic?.error).toMatchObject({ name: "TypeError", message: "terminated" });
		expect(diagnostic?.error?.stack).toContain("terminated");
		expect(diagnostic?.details).toMatchObject({
			cause: { message: "other side closed", code: "UND_ERR_SOCKET" },
		});
		expect(typeof diagnostic?.details?.headersAtMs).toBe("number");
		expect(typeof diagnostic?.details?.elapsedMs).toBe("number");
		expect(diagnostic?.details?.status).toBeUndefined();
	});

	it("marks an HTTP error response with its status", async () => {
		const serverError: FetchFunction = async () =>
			new Response(JSON.stringify({ error: { message: "upstream overloaded" } }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		const message = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: serverError,
			maxRetries: 0,
		}).result();

		const diagnostic = message.diagnostics?.find((d) => d.type === "provider_request_failure");
		expect(diagnostic?.details).toMatchObject({ status: 503 });
		expect(diagnostic?.details?.headersAtMs).toBeUndefined();
	});

	it("records nothing when the caller aborts", async () => {
		const controller = new AbortController();
		const hang: FetchFunction = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				controller.abort();
			});
		const message = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: hang,
			signal: controller.signal,
			maxRetries: 0,
		}).result();

		expect(message.stopReason).toBe("aborted");
		expect(message.diagnostics ?? []).toEqual([]);
	});
});
