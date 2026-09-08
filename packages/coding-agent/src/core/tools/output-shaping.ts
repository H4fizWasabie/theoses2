import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadonlySessionManager } from "../session-manager.ts";

export interface SpillOutputOptions {
	/** Full, untruncated raw output to persist. */
	raw: string;
	/** Tool name, used for the artifact label and filename. */
	tool: string;
	/** Session manager from the tool's execution context, if available. */
	sessionManager?: ReadonlySessionManager;
}

/**
 * Persist the full output of a truncated tool result as a session artifact,
 * so the model can retrieve what was cut instead of losing it permanently.
 * Uses the same session-scoped artifact directory and catalog as document
 * attachments (`storeArtifact`), so spilled output shows up in the model's
 * artifact catalog automatically, not just in the tool's own notice text.
 *
 * Fails open: with no session manager (e.g. a standalone/test invocation) or
 * on a write error, returns undefined and the caller falls back to whatever
 * notice it already has without the retrieval path.
 */
export function spillTruncatedOutput(options: SpillOutputOptions): string | undefined {
	const { raw, tool, sessionManager } = options;
	if (!sessionManager) return undefined;
	try {
		const dir = sessionManager.getArtifactDirectory();
		const path = join(dir, `${tool}-${Date.now()}.txt`);
		const data = Buffer.from(raw, "utf-8");
		writeFileSync(path, data, { mode: 0o600 });
		sessionManager.appendArtifact(`${tool} output`, path, data.byteLength);
		return path;
	} catch {
		return undefined;
	}
}
