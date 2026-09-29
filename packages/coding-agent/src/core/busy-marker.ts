import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Directory under the agent dir where a running operation leaves a marker for the self-updater
 * (scripts/theoses-updater/update.sh). A session file is only written when a message ends, so a long
 * tool run or a long reasoning phase leaves it untouched and looks idle; the marker does not.
 * Marker names start with the owning pid, so the updater can ignore one left behind by a crash.
 */
export const BUSY_DIR_NAME = "busy";

/**
 * Marks an operation of `sessionId` as running until the returned function is called. Never throws: a
 * marker that cannot be written must not fail the turn, it only leaves the updater on its file-mtime fallback.
 */
export function markBusy(sessionId: string, agentDir: string = getAgentDir()): () => void {
	const directory = join(agentDir, BUSY_DIR_NAME);
	const path = join(directory, `${process.pid}-${sessionId}`);
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path, "");
	} catch {
		return () => {};
	}
	return () => {
		try {
			rmSync(path, { force: true });
		} catch {
			// Left behind, the marker is ignored once this pid is gone.
		}
	};
}
