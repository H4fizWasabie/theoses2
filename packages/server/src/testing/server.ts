import { TheosesServer } from "../server.ts";
import type { TheosesServerOptions, TheosesServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends TheosesServerOptions {
	service?: TheosesServerService;
}

export interface TestServer {
	server: TheosesServer;
	service: TheosesServerService;
}

/** Create an unstarted TheosesServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new TheosesServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
