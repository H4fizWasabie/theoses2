import type { Api, Model, ProviderHeaders, SimpleStreamOptions } from "theoses-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";

/**
 * The provider hooks every Agent in a session (the main one and background sub-agents) routes through
 * the extension runner's before_provider_request / after_provider_response / before_provider_headers
 * events, so extensions such as cost-watch see each request under the model actually sending it.
 * `transformHeaders` takes that model as a second argument (issue #263); theoses-ai's own
 * transformHeaders type has none, so each Agent binds it to its model when handing it to streamSimple.
 */
export interface ProviderHooks {
	onPayload: NonNullable<SimpleStreamOptions["onPayload"]>;
	onResponse: NonNullable<SimpleStreamOptions["onResponse"]>;
	transformHeaders(headers: ProviderHeaders | undefined, model: Model<Api>): Promise<ProviderHeaders>;
}

/**
 * `getRunner` is read on every request: background-agent tools are built before the ExtensionRunner,
 * and the runner is replaced on runtime rebuilds.
 */
export function extensionProviderHooks(getRunner: () => ExtensionRunner | undefined): ProviderHooks {
	return {
		async onPayload(payload, model) {
			const runner = getRunner();
			return runner?.hasHandlers("before_provider_request")
				? runner.emitBeforeProviderRequest(payload, model)
				: payload;
		},
		async onResponse(response, model) {
			const runner = getRunner();
			if (runner?.hasHandlers("after_provider_response")) {
				await runner.emitAfterProviderResponse({ status: response.status, headers: response.headers }, model);
			}
		},
		async transformHeaders(headers, model) {
			const runner = getRunner();
			return runner?.hasHandlers("before_provider_headers")
				? runner.emitBeforeProviderHeaders(headers ?? {}, model)
				: (headers ?? {});
		},
	};
}
