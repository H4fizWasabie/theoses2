import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, Model } from "../src/types.ts";

const model = { id: "m", api: "anthropic-messages", provider: "p" } as Model<Api>;

describe("lazyStream setup failure", () => {
	it("reports an abort during setup (e.g. auth resolution) as aborted", async () => {
		const signal = AbortSignal.abort();
		const result = await lazyStream(model, async () => {
			signal.throwIfAborted();
			throw new Error("unreachable");
		}).result();
		expect(result.stopReason).toBe("aborted");
	});

	it("reports any other setup failure as an error", async () => {
		const result = await lazyStream(model, async () => {
			throw new Error("no API key");
		}).result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "no API key" });
	});
});
