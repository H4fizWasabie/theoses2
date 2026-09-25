import { getModel } from "theoses-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { extensionProviderHooks } from "../src/core/provider-hooks.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("extensionProviderHooks", () => {
	it("passes requests through untouched while no runner or handler exists", async () => {
		const hooks = extensionProviderHooks(() => undefined);
		expect(await hooks.onPayload({ a: 1 }, model)).toEqual({ a: 1 });
		expect(await hooks.transformHeaders(undefined, model)).toEqual({});
		await hooks.onResponse({ status: 200, headers: {} }, model);
	});

	it("reads the runner on every request and emits each event under the request's model", async () => {
		const runner = {
			hasHandlers: () => true,
			emitBeforeProviderRequest: vi.fn(async () => ({ replaced: true })),
			emitAfterProviderResponse: vi.fn(async () => {}),
			emitBeforeProviderHeaders: vi.fn(async () => ({ "x-hook": "1" })),
		};
		let current: ExtensionRunner | undefined;
		const hooks = extensionProviderHooks(() => current);
		expect(await hooks.onPayload({ a: 1 }, model)).toEqual({ a: 1 });

		current = runner as unknown as ExtensionRunner;
		expect(await hooks.onPayload({ a: 1 }, model)).toEqual({ replaced: true });
		expect(await hooks.transformHeaders({ "x-in": "1" }, model)).toEqual({ "x-hook": "1" });
		await hooks.onResponse({ status: 429, headers: { "retry-after": "1" } }, model);

		expect(runner.emitBeforeProviderRequest).toHaveBeenCalledWith({ a: 1 }, model);
		expect(runner.emitBeforeProviderHeaders).toHaveBeenCalledWith({ "x-in": "1" }, model);
		expect(runner.emitAfterProviderResponse).toHaveBeenCalledWith(
			{ status: 429, headers: { "retry-after": "1" } },
			model,
		);
	});
});
