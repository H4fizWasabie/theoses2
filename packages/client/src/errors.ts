import type { JsonValue, ProtocolError, ProtocolErrorCode } from "theoses-protocol";

export class TheosesServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "TheosesServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class TheosesDisconnectedError extends Error {
	constructor(message = "Pi client is disconnected") {
		super(message);
		this.name = "TheosesDisconnectedError";
	}
}

export class TheosesClientDisposedError extends Error {
	constructor() {
		super("Pi client is disposed");
		this.name = "TheosesClientDisposedError";
	}
}

export class TheosesSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "TheosesSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class TheosesSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "TheosesSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): TheosesDisconnectedError {
	const cause = toError(error);
	return cause instanceof TheosesDisconnectedError ? cause : new TheosesDisconnectedError(cause.message);
}
