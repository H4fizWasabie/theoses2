import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^theoses-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^theoses-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^theoses-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^theoses-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^theoses-ai\/api\/(.+)$/, replacement: `${workspaceSourcePaths.aiApi}/$1.ts` },
			{ find: /^theoses-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^theoses-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
