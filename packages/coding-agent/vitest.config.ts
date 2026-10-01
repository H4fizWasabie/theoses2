import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// Suite-level isolation: one temp agent root per run, so a test that forgets to stub the agent dir
// resolves to this root instead of the developer's real ~/.theoses/agent (issue #486). The root is
// removed afterwards by test/global-setup.ts. Both paths are derived here, and THEOSES_MEMORY_DIR is
// pinned too so memory/episodic writes (getMemoriesDir, dirname(getAgentDir())) land inside the root.
const testAgentRoot = mkdtempSync(join(tmpdir(), "theoses-test-agent-"));
mkdirSync(join(testAgentRoot, "agent"), { recursive: true });
mkdirSync(join(testAgentRoot, "memories"), { recursive: true });
// Shared with test/global-setup.ts's teardown (same Vitest main process) so it knows what to remove.
process.env.__THEOSES_TEST_AGENT_ROOT = testAgentRoot;

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: {
				THEOSES_OFFLINE: "1",
				THEOSES_CODING_AGENT_DIR: join(testAgentRoot, "agent"),
				THEOSES_MEMORY_DIR: join(testAgentRoot, "memories"),
			},
			globalSetup: [fileURLToPath(new URL("./test/global-setup.ts", import.meta.url))],
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^theoses-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^theoses-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
