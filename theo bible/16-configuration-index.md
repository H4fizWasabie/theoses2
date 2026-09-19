# Configuration index

This is a source-derived index of configuration fields and environment names. It documents names and precedence without copying values. Project context and README examples are descriptive only; the cited implementation decides behavior.

## Settings file

`SettingsManager` reads global settings from `<agentDir>/settings.json` and project settings from `<cwd>/.theoses/settings.json`, migrates selected legacy shapes, and deep-merges project over global settings when the project is trusted ([packages/coding-agent/src/core/settings-manager.ts](../packages/coding-agent/src/core/settings-manager.ts), `FileSettingsStorage`/`SettingsManager`, lines 208-380 and 419-548).

| Field | Shape / values | Implemented default or rule |
|---|---|---|
| `lastChangelogVersion` | string | Changelog bookkeeping |
| `defaultProvider`, `defaultModel` | string | Seed model selection |
| `summarizationProvider`, `summarizationModel` | string | Maintenance calls use these when set; otherwise active model |
| `backgroundModels` | `consolidation` / `explorer` → `model`, `providers`, `quantizations` | Overrides the OpenRouter model and provider routing of memory consolidation (and task-boundary summaries) and the explorer; code defaults otherwise; read at startup |
| `defaultThinkingLevel` | thinking level | Model capability clamping applies |
| `modelThinkingLevels` | provider/model → thinking level | Per-model override |
| `transport` | `auto` / transport value | `auto` |
| `steeringMode`, `followUpMode` | `all` / `one-at-a-time` | Queue policy |
| `theme` | string | Theme selection |
| `compaction` | `enabled`, `reserveTokens`, `keepRecentTokens`, `maxHistoryTurns`, `maxDeferredTurns` | enabled; 16,384 reserve; 20,000 recent; 3 turns; 0 deferred turns (no cache-warm deferral) |
| `branchSummary` | `reserveTokens`, `skipPrompt` | 16,384 reserve; prompt shown |
| `retry` | enabled, max/base delay, provider retry settings | enabled; 3 retries; 2,000 ms base; provider delay ceiling 60,000 ms |
| `hideThinkingBlock`, `showCacheMissNotices` | boolean | false |
| `externalEditor`, `shellPath`, `shellCommandPrefix`, `npmCommand` | string/path/argv | Editor falls back to `VISUAL`, `EDITOR`, then platform default |
| `quietStartup`, `collapseChangelog` | boolean | false |
| `defaultProjectTrust` | `ask` / `always` / `never` | `ask`; global-only |
| `enableAnalytics`, `trackingId` | boolean/string | opt-in; tracking ID generated on first opt-in |
| `extensions`, `skills`, `prompts`, `themes` | string arrays | Resource paths |
| `enableSkillCommands` | boolean | true |
| `terminal` | `showImages`, `imageWidthCells`, `clearOnShrink`, `showTerminalProgress` | images true; width 60; progress false; clear false unless env fallback |
| `images` | `autoResize`, `blockImages` | resize true; block false |
| `enabledModels`, `defaultTools` | string arrays | Model cycling and initial tools |
| `toolSources` | sidecar/MCP/MCP-stdio union | Named tool-source list; duplicate names rejected |
| `doubleEscapeAction` | `fork` / `tree` / `none` | `tree` |
| `treeFilterMode` | default/no-tools/user-only/labeled-only/all | `default` |
| `thinkingBudgets` | per-level numeric values | Optional custom budgets |
| `editorPaddingX`, `outputPad`, `autocompleteMaxVisible` | bounded numbers | 0; 1; 5 |
| `showHardwareCursor` | boolean | setting, then env, then false |
| `markdown` | `codeBlockIndent`, `mermaid` | two-space indent; streaming Mermaid |
| `warnings` | warning toggles | Provider-specific warning settings |
| `sessionDir` | path | CLI/session directory override |
| `httpProxy` | URL/string | Applied to managed HTTP clients |
| `httpIdleTimeoutMs`, `websocketConnectTimeoutMs` | non-negative numbers | HTTP and WebSocket timeout settings |
| `tuiMode` | regular/fullscreen | regular |
| `fullscreenExitOutput` | transcript/resume-hint | transcript |
| `fullscreenScrollbar` | auto/always/hidden | auto |

The complete TypeScript field contract is [settings-manager.ts](../packages/coding-agent/src/core/settings-manager.ts), `Settings`, lines 85-141. Accessor defaults and validation are in lines 830-1372.

## Theoses runtime environment

| Names | Consumer / purpose | Evidence |
|---|---|---|
| `THEOSES_CODING_AGENT`, `AI_AGENT` | CLI/runtime identity markers | [packages/coding-agent/src/cli.ts](../packages/coding-agent/src/cli.ts), lines 11-15 |
| `THEOSES_PACKAGE_DIR`, `THEOSES_CODING_AGENT_DIR`, `THEOSES_CODING_AGENT_SESSION_DIR`, `THEOSES_MEMORY_DIR` | Package, agent, session, and memory path overrides | [packages/coding-agent/src/config.ts](../packages/coding-agent/src/config.ts), lines 387-399 and 479-538 |
| `THEOSES_OFFLINE`, `THEOSES_STARTUP_BENCHMARK`, `THEOSES_EXPERIMENTAL` | Offline/model refresh, startup benchmark, experimental features | [packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 563-565 and 904-918; [packages/coding-agent/src/core/experimental.ts](../packages/coding-agent/src/core/experimental.ts), lines 1-6 |
| `THEOSES_EPISODIC_DB`, `THEOSES_MEMORY_FILE`, `THEOSES_CONSOLIDATION_CHECKPOINTS` | Episodic DB, legacy memory path, consolidation checkpoints | [packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), lines 28-34; [packages/coding-agent/src/core/memory-store.ts](../packages/coding-agent/src/core/memory-store.ts), lines 200-206; [packages/coding-agent/src/core/memory-consolidation.ts](../packages/coding-agent/src/core/memory-consolidation.ts), lines 68-78 |
| `THEOSES_DEBUG_CONSOLIDATION`, `THEOSES_DEBUG_TASK_BOUNDARY`, `THEOSES_TIMING` | Debug/timing output | [packages/coding-agent/src/core/memory-consolidation.ts](../packages/coding-agent/src/core/memory-consolidation.ts), lines 500-505; [packages/coding-agent/src/core/timings.ts](../packages/coding-agent/src/core/timings.ts), lines 1-8 |
| `THEOSES_IMAGE_MODEL`, `THEOSES_OPENROUTER_IMAGE_MODEL`, `TAVILY_API_KEY`, `TAVILY_API_KEY_2` | Image generation and web-search provider configuration | [packages/coding-agent/src/core/tools/generate-image.ts](../packages/coding-agent/src/core/tools/generate-image.ts), lines 28-78; [packages/coding-agent/src/core/tools/web-search.ts](../packages/coding-agent/src/core/tools/web-search.ts), lines 65-77 |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `OPENROUTER_API_KEY`, `LLAMA_BASE_URL` | Image/extension provider configuration | [packages/coding-agent/src/core/tools/generate-image.ts](../packages/coding-agent/src/core/tools/generate-image.ts), lines 28-78; [packages/coding-agent/src/extensions/llama/provider.ts](../packages/coding-agent/src/extensions/llama/provider.ts), lines 75-86 |
| `THEOSES_DASHBOARD_CWD`, `THEOSES_DASHBOARD_TOKEN`, `THEOSES_DASHBOARD_HOST`, `THEOSES_DASHBOARD_PORT` | Dashboard cwd, auth, bind host, port | [packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), lines 524-568 |
| `THEOSES_TELEGRAM_BOT_TOKEN`, `THEOSES_TELEGRAM_CHAT_ID`, `THEOSES_TELEGRAM_CWD` | Telegram credentials, owner chat, stable session cwd | [packages/telegram/src/index.ts](../packages/telegram/src/index.ts), lines 387-406 |
| `HTTP_PROXY`, `HTTPS_PROXY` | Managed HTTP proxy values | [packages/coding-agent/src/core/http-dispatcher.ts](../packages/coding-agent/src/core/http-dispatcher.ts), lines 39-52 |
| `VISUAL`, `EDITOR` | External editor fallback | [packages/coding-agent/src/core/settings-manager.ts](../packages/coding-agent/src/core/settings-manager.ts), lines 944-953 |
| `HOME`, `USERPROFILE`, `PNPM_HOME`, `WSL_DISTRO_NAME`, `WSL_INTEROP`, `SystemRoot`, `WINDIR`, `ProgramFiles`, `ProgramFiles(x86)` | Platform/path discovery | [packages/coding-agent/src/config.ts](../packages/coding-agent/src/config.ts), lines 125-131; [packages/coding-agent/src/core/trust-manager.ts](../packages/coding-agent/src/core/trust-manager.ts), lines 180-190; [packages/coding-agent/src/utils/shell.ts](../packages/coding-agent/src/utils/shell.ts), lines 75-90 |
| `RTK_DISABLED` | Preserve bash command behavior when RTK integration is disabled | [packages/coding-agent/src/core/tools/bash.ts](../packages/coding-agent/src/core/tools/bash.ts), lines 35-48 |

## Provider authentication names

Standard API-key providers resolve the first configured environment name after a stored credential. The authoritative provider-to-environment map is `getApiKeyEnvVars` ([packages/ai/src/env-api-keys.ts](../packages/ai/src/env-api-keys.ts), lines 68-120). Names below are identifiers only; values are never documented.

`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`, `ANT_LING_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `NVIDIA_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLOUD_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `RADIUS_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY`, `MISTRAL_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`, `MOONSHOT_API_KEY`, `HF_TOKEN`, `FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `BASETEN_API_KEY`, `OPENCODE_API_KEY`, `KIMI_API_KEY`, `CLOUDFLARE_API_KEY`, `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_CN_API_KEY`, `XIAOMI_TOKEN_PLAN_AMS_API_KEY`, and `XIAOMI_TOKEN_PLAN_SGP_API_KEY` are mapped there.

Special ambient credential inputs are `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`. Their presence is checked without exposing values ([packages/ai/src/env-api-keys.ts](../packages/ai/src/env-api-keys.ts), lines 153-180; [packages/ai/src/providers/amazon-bedrock.ts](../packages/ai/src/providers/amazon-bedrock.ts), lines 44-86; [packages/ai/src/providers/google-vertex.ts](../packages/ai/src/providers/google-vertex.ts), lines 54-96).

## Terminal and test environment

Terminal detection also reads `TERM_PROGRAM`, `TERMINAL_EMULATOR`, `TERM`, `COLORTERM`, `TMUX`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `WEZTERM_PANE`, `WARP_SESSION_ID`, `WARP_TERMINAL_SESSION_UUID`, `ITERM_SESSION_ID`, `WT_SESSION`, `ZELLIJ`, `STY`, `TERMUX_VERSION`, `DISPLAY`, `WAYLAND_DISPLAY`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `COLUMNS`, `LINES`, `THEOSES_HARDWARE_CURSOR`, `THEOSES_CLEAR_ON_SHRINK`, `THEOSES_TUI_WRITE_LOG`, `THEOSES_DEBUG_REDRAW`, and `THEOSES_TUI_DEBUG` ([packages/tui/src/terminal-image.ts](../packages/tui/src/terminal-image.ts), lines 65-108; [packages/tui/src/terminal.ts](../packages/tui/src/terminal.ts), lines 130-145 and 480-500; [packages/tui/src/tui-alt-screen.ts](../packages/tui/src/tui-alt-screen.ts), lines 270-290).

Build/test-only names include `GITHUB_ACTIONS`, `THEOSES_ALLOW_LOCKFILE_CHANGE`, `THEOSES_EVAL_ARTIFACT_DIR`, `THEOSES_TUI_WIN32_TOOLCHAIN`, `CC`, and `npm_config_user_agent`. They are not application runtime configuration ([.github/workflows/ci.yml](../.github/workflows/ci.yml), lines 16-43; `packages/*/vitest.config.ts`; `scripts/check-lockfile-commit.mjs`, lines 1-8).
