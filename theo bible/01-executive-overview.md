# Executive overview

## System in one paragraph

Theoses2 is a self-hosted, single-owner personal assistant and coding harness. It can run as an interactive terminal UI, print/JSON command, RPC process, or embedded SDK session. The common runtime is a model-backed `AgentSession` with append-only session persistence, bounded active context, built-in and extension tools, durable semantic memory, episodic history, and provider/model selection. The repository also contains transport-neutral client/server packages, a dashboard adapter, and a Telegram adapter. The CLI entrypoint delegates construction to the SDK and runtime layers ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), `main`, lines 1-6, 920-970; [packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), `createAgentSession`, lines 225-487).

## Primary ownership boundary

`packages/coding-agent` owns the product runtime: sessions, settings, resources, tools, memory, modes, and adapters. `packages/agent` owns the reusable agent loop and event stream. `packages/ai` owns provider APIs, model metadata, authentication, streaming, and cost/usage types. `packages/protocol`, `packages/server`, and `packages/client` are an experimental remote-session boundary; the server deliberately requires an application-supplied durable-session service ([packages/server/src/types.ts](../packages/server/src/types.ts), `TheosesServerService`, lines 42-62; [packages/server/README.md](../packages/server/README.md), “Session server core”).

## User-visible surfaces

- Terminal: interactive TUI, print/JSON, and RPC modes selected by parsed arguments and TTY state ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), `resolveCliPaths`/`main`, lines 570-636 and 920-970).
- Dashboard: authenticated HTTP API, SSE chat stream, session/file/memory routes, and static assets ([packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), `createDashboardServer`/`streamChat`, lines 57-115 and 334-554).
- Telegram: owner-only bot, per-chat serialized queue, attachments, stop handling, tool status, and reply formatting ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), `createTelegramBot`, lines 387-763).

## Main architectural fact

The durable unit is a channel session, not a one-shot prompt. A session manager selects or creates the session file, the runtime binds cwd-scoped services, `AgentSession` restores context and persistence, and the low-level `Agent` executes model/tool turns. Channel adapters add transport-specific concerns around that same session model. Session headers carry channel and channel-session identity ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `SessionEntry`/`SessionManager`, lines 31-64 and 1030-1050).

## Current evidence limit

The codebase-wide Bible completion gate passes for the current tracked revision: every in-scope path was inspected, while generated, vendored, lockfile, and binary artifacts are explicitly excluded with reasons. Live provider, terminal, browser, Telegram, deployment, and full-suite execution remain environment-dependent evidence gaps. See [15-open-questions.md](15-open-questions.md).
