# Interfaces

## Public package interfaces

| Interface | Boundary | Key contract |
|---|---|---|
| `Agent` | `theoses-agent-core` | Prompt/continue/abort, queued steering/follow-up, lifecycle events, provider stream ([packages/agent/src/agent.ts](../packages/agent/src/agent.ts), lines 216-388) |
| `createAgentSession` | coding-agent SDK | Constructs model/session/services/tool wiring from cwd, agentDir, model, thinking, and tool options ([packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), lines 45-117 and 225-487) |
| `TheosesSessionRuntime` | server service boundary | Snapshot, phase, prompt/steer/abort, model/thinking mutation, subscription, disposal ([packages/server/src/types.ts](../packages/server/src/types.ts), lines 20-40) |
| `TheosesServerService` | server storage/runtime injection | List sessions/models and create/open durable runtimes ([packages/server/src/types.ts](../packages/server/src/types.ts), lines 42-62) |
| `ByteTransport` | client transport boundary | Ordered byte send, close, inbound data/close/error handlers ([packages/client/src/transport.ts](../packages/client/src/transport.ts), `ByteTransport` and factory) |
| `SessionLease` / `SessionHandle` | client session boundary | Attached lease exposes snapshot/subscriptions and typed prompt, steer, abort, model, thinking, detach, and disposal operations ([packages/client/src/session-handle.ts](../packages/client/src/session-handle.ts), lines 1-111) |
| `TheosesClient` | client connection/session boundary | Connects through an authenticated byte transport, correlates typed protocol requests, applies monotonic snapshots/events, and enforces shared/exclusive session ownership ([packages/client/src/client.ts](../packages/client/src/client.ts), lines 45-432) |
| `TheosesServerListener` | server listener boundary | Start authorized byte connections and close ([packages/server/src/listener.ts](../packages/server/src/listener.ts), lines 1-15) |
| `createUnixListener` / `createUnixServer` | Unix transport boundary | Bind a mode-controlled Unix socket, pass ordered byte connections into the common server, enforce pending-byte and graceful-close limits, and remove only the owned socket identity on shutdown ([packages/server/src/transports/unix/listener.ts](../packages/server/src/transports/unix/listener.ts), lines 1-437; [packages/server/src/transports/unix/preset.ts](../packages/server/src/transports/unix/preset.ts), lines 1-23) |
| `TelemetryContext` | telemetry adapter boundary | Explicit parent context and callback-owned span settlement ([packages/telemetry/README.md](../packages/telemetry/README.md), “Adapter Contract”) |
| `ExtensionFactory` / `ExtensionAPI` / `ExtensionContext` | coding-agent extension boundary | Factory registration of tools, commands, shortcuts, flags, renderers, transformers, providers, and handlers; runtime context exposes UI, session, model, trust, abort, compaction, and prompt access ([packages/coding-agent/src/core/extensions/types.ts](../packages/coding-agent/src/core/extensions/types.ts), public types; [packages/coding-agent/src/core/extensions/runner.ts](../packages/coding-agent/src/core/extensions/runner.ts), context/binding/dispatch, lines 270-1236) |

## Wire protocol

Client commands are `list`, `create`, `attach`, `detach`, `prompt`, `steer`, `abort`, `set_model`, and `set_thinking`. Server responses return command-specific results; events carry session progress, session snapshots, server snapshots, or session removal ([packages/protocol/src/schemas.ts](../packages/protocol/src/schemas.ts), command/result/event schemas, lines 291-450).

The coding-agent RPC is distinct from the experimental remote protocol. It is a child-process JSONL interface with optional command IDs; its command union is in `RpcCommand`, and `RpcClient` spawns `node`, forwards environment overrides, reads stdout JSON lines, correlates responses, and terminates with SIGTERM/SIGKILL fallback ([packages/coding-agent/src/modes/rpc/rpc-types.ts](../packages/coding-agent/src/modes/rpc/rpc-types.ts), lines 20-73; [packages/coding-agent/src/modes/rpc/rpc-client.ts](../packages/coding-agent/src/modes/rpc/rpc-client.ts), `RpcClient.start`/`stop`, lines 56-167).

Wire schemas reject unknown object properties and model only JSON-compatible values. The server-side adapter maps `theoses-ai` messages, models, usage, tool calls, and diagnostic details into the protocol subset ([packages/protocol/src/codec.ts](../packages/protocol/src/codec.ts), `parse*Message`/`encode*Message`, lines 34-180; [packages/server/src/protocol.ts](../packages/server/src/protocol.ts), mapping functions, lines 1-260).

The server adapter is deliberately lossy at the protocol boundary: it keeps transcript-visible content, model identity, supported thinking levels, usage, and sanitized tool details, while omitting provider replay metadata and rejecting deferred assistant messages. Execution-facing JSON values are strict about finite values, plain objects, and cycles; diagnostic details use a lossy sanitizer ([packages/server/src/protocol.ts](../packages/server/src/protocol.ts), field-accounting assertions and mapper functions, lines 1-382).

Extension event handlers are ordered and composable: message/context/provider/resource/input transformations feed the next handler, while session-before and tool-call results can cancel/block. The runner reports most handler failures as extension diagnostics; tool-call handler failures are allowed to propagate. Extension contexts become invalid after reload or session replacement ([packages/coding-agent/src/core/extensions/runner.ts](../packages/coding-agent/src/core/extensions/runner.ts), `ExtensionRunner.emit*` and `invalidate`, lines 400-1236; [packages/coding-agent/src/core/extensions/loader.ts](../packages/coding-agent/src/core/extensions/loader.ts), runtime invalidation, lines 155-221).

## Security contracts

The common server does not perform transport authentication; listeners must authenticate before handing connections to it. The client README similarly treats peers as untrusted and requires a secure, access-controlled transport ([packages/server/src/listener.ts](../packages/server/src/listener.ts), lines 1-15; [packages/client/README.md](../packages/client/README.md), “Limits and security”).

The dashboard requires a configured bearer token and uses timing-safe comparison/cookie authentication; without a token it returns service-unavailable behavior ([packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), auth helpers, lines 57-115). Telegram requires both bot token and owner chat ID and ignores non-owner chats ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), `createTelegramBot`/handler, lines 387-443).

## Compatibility status

The protocol/client/server packages explicitly describe themselves as experimental or without compatibility guarantees. Treat changes there as coordinated changes across schemas, codec, server, client, and conformance tests ([packages/server/README.md](../packages/server/README.md), opening notice; [packages/protocol/README.md](../packages/protocol/README.md), protocol compatibility notice).
