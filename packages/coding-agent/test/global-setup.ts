import { rmSync } from "node:fs";

/**
 * Suite-level isolation for the agent/memory directories.
 *
 * The vitest config creates one temp agent root per run and points THEOSES_CODING_AGENT_DIR and
 * THEOSES_MEMORY_DIR at it (see vitest.config.ts). This teardown removes that root afterwards so a
 * test that forgets to stub the agent dir can never write into the developer's real ~/.theoses/agent,
 * and the temp files do not accumulate.
 *
 * The root path is shared with the config through process.env: both the config module and this
 * globalSetup run in the same Vitest main process, so the value set at config-load time is visible
 * here at teardown time.
 */
export function teardown(): void {
	const root = process.env.__THEOSES_TEST_AGENT_ROOT;
	if (root) {
		rmSync(root, { recursive: true, force: true });
	}
}
