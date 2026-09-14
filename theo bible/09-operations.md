# Operations

## Local commands

Root scripts are the operational contract. The manifest defines build, check, targeted script tests, model-data generation/checks, evaluation, package tests, lockfile/install-lock validation, and local release commands ([package.json](../package.json), `scripts`, lines 1-95).

The coding-agent package exposes the CLI entrypoint through `packages/coding-agent/src/cli.ts`, which sets the app identity environment and invokes `main` ([packages/coding-agent/src/cli.ts](../packages/coding-agent/src/cli.ts), lines 1-21). The CLI help is the source for user-facing flags and environment-variable names ([packages/coding-agent/src/cli/args.ts](../packages/coding-agent/src/cli/args.ts), `printHelp`, lines 251-440).

## Storage locations

Default global state is derived from the app identity: agent files under `~/.theoses/agent`, project state under `.theoses`, sessions under an encoded cwd directory, and memory beside the agent directory unless overridden ([packages/coding-agent/src/config.ts](../packages/coding-agent/src/config.ts), lines 479-599; [packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), lines 28-34).

## Unix server transport

The server binds a private hashed socket path, then links the configured public path to it. Startup rejects empty or overlong paths, non-socket collisions, live listeners, invalid modes, and invalid frame/backpressure/close limits; shutdown verifies device/inode identity before removing the socket ([packages/server/src/transports/unix/listener.ts](../packages/server/src/transports/unix/listener.ts), `UnixListener.start`/`closeInternal`/`cleanupOwnedSocket`/`resolveUnixListenerOptions`, lines 44-176 and 352-437). Each connection serializes writes, copies outbound bytes, rejects writes over the pending-byte bound, and force-closes after the graceful timeout ([packages/server/src/transports/unix/listener.ts](../packages/server/src/transports/unix/listener.ts), `UnixByteConnection.send`/`close`, lines 221-306).

## Environment names

The code reads app/runtime overrides such as `THEOSES_OFFLINE`, `THEOSES_PROVIDER`, `THEOSES_MODEL`, `THEOSES_SESSION_DIR`, `THEOSES_MEMORY_FILE`, `THEOSES_EPISODIC_DB`, dashboard host/port/token names, Telegram token/chat/cwd names, and provider credential names. Names are documented here only; secret values are intentionally omitted. The canonical local list is the CLI help and `process.env` reads in `packages/coding-agent/src`, `packages/dashboard/src`, and `packages/telegram/src`.

## Dashboard deployment constraints

The dashboard defaults to host `127.0.0.1` and port `7788`; all `/api/` routes except login are protected. File writes use optimistic version checks and atomic temporary-file rename, while deletes are recursive and therefore operationally destructive ([packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), `createDashboardServer`/`runDashboard`, lines 422-568; [packages/dashboard/src/files.ts](../packages/dashboard/src/files.ts), lines 4-105).

## Telegram deployment constraints

Set a stable `THEOSES_TELEGRAM_CWD` when releases run through changing version directories; otherwise the cwd-derived session path can orphan continuity across releases ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), `createTelegramBot`, lines 399-406). Downloads are bounded to 20 MiB and time out after 120 seconds ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), constants/download path, lines 20-33 and 290-333).

## CI and release evidence

The main CI workflow installs Node 22 dependencies with `npm ci --ignore-scripts`, then runs build, check, and the full test command ([.github/workflows/ci.yml](../.github/workflows/ci.yml), `build-check-test`, lines 1-43). This baseline did not run that full suite because the requested change is documentation-only; see [10-testing.md](10-testing.md).
