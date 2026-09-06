import type { JsonValue, ProtocolErrorCode } from "theoses-protocol";

export type TheosesServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	"busy" | "session_locked" | "not_found" | "invalid_request" | "not_implemented"
>;

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
export const NOT_IMPLEMENTED_MESSAGE = "Operation is not implemented";

/** A service/runtime error that can safely cross the protocol boundary. */
export class TheosesServerError extends Error {
	readonly code: TheosesServerOperationErrorCode;
	readonly details: JsonValue | undefined;

	constructor(code: TheosesServerOperationErrorCode, message: string, details?: JsonValue) {
		super(message);
		this.name = "TheosesServerError";
		this.code = code;
		this.details = details;
	}
}

export class SessionBusyError extends TheosesServerError {
	constructor(message = "Session is busy", details?: JsonValue) {
		super("busy", message, details);
		this.name = "SessionBusyError";
	}
}

export class SessionLockedError extends TheosesServerError {
	constructor(message = "Session is locked", details?: JsonValue) {
		super("session_locked", message, details);
		this.name = "SessionLockedError";
	}
}

export class SessionNotFoundError extends TheosesServerError {
	constructor(message = "Session was not found", details?: JsonValue) {
		super("not_found", message, details);
		this.name = "SessionNotFoundError";
	}
}

export class NotImplementedError extends TheosesServerError {
	constructor() {
		super("not_implemented", NOT_IMPLEMENTED_MESSAGE);
		this.name = "NotImplementedError";
	}
}

/** An unsafe failure whose cause is retained for reporting but never serialized. */
export class InternalServerError extends Error {
	constructor(cause: unknown) {
		super(INTERNAL_SERVER_ERROR_MESSAGE, { cause });
		this.name = "InternalServerError";
	}
}
