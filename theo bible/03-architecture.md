# Architecture

## Runtime layers

```text
CLI / TUI / print / RPC / dashboard / Telegram
                    │
             AgentSessionRuntime
                    │
          AgentSession + services
                    │
              Agent + agent-loop
                    │
          ModelRuntime → theoses-ai provider
```

The CLI resolves the final session cwd before constructing cwd-bound settings, resources, provider registrations, and models ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), `main`, lines 659-769). `createAgentSessionServices` creates the model runtime, settings manager, resource loader, and diagnostics; `createAgentSessionFromServices` then delegates to the SDK ([packages/coding-agent/src/core/agent-session-services.ts](../packages/coding-agent/src/core/agent-session-services.ts), lines 137-223).

## Runtime lifecycle

`AgentSessionRuntime` owns the current session plus cwd-bound services. Switching, creating, forking, and importing sessions first tear down the current session, aborting and waiting for idle before disposal ([packages/coding-agent/src/core/agent-session-runtime.ts](../packages/coding-agent/src/core/agent-session-runtime.ts), `teardownCurrent` and switch methods, lines 169-398). This is the main lifecycle seam for adapters that need to change sessions.

## Agent boundary

`AgentSession` is the product-facing state machine: it combines persistence, model selection, compaction, tool binding, extension hooks, and user input. The low-level `Agent` owns queued prompts, abort/wait state, event subscription, and the provider turn loop ([packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), class and events, lines 154-372; [packages/agent/src/agent.ts](../packages/agent/src/agent.ts), `Agent`, lines 216-388).

Before each provider call, the low-level loop converts the flexible `AgentMessage[]` context at the provider boundary; tools execute between assistant turns and tool results are appended before the next turn ([packages/agent/README.md](../packages/agent/README.md), “AgentMessage vs LLM Message” and “With Tool Calls”; [packages/agent/src/agent-loop.ts](../packages/agent/src/agent-loop.ts), `runLoop`, lines 152-275).

## Remote boundary

The protocol uses strict TypeBox schemas, protocol version `1`, CBOR payloads, and a four-byte unsigned big-endian length prefix with a default 16 MiB payload limit ([packages/protocol/src/schemas.ts](../packages/protocol/src/schemas.ts), lines 1-7 and 384-450; [packages/protocol/src/framing.ts](../packages/protocol/src/framing.ts), lines 1-61). The server requires `hello` as the first message, validates the version, sends a snapshot, and routes later requests only after the handshake ([packages/server/src/server.ts](../packages/server/src/server.ts), `accept`/`dispatchMessage`/`finishHandshake`, lines 99-233).

The server is not a coding-agent daemon by itself. `TheosesServerService` supplies listing, model listing, create, and open operations; `LiveSessionManager` acquires one runtime per session, attaches connections, rejects commands from unattached connections, broadcasts progress/snapshots, and disposes idle unshared runtimes ([packages/server/src/types.ts](../packages/server/src/types.ts), lines 42-62; [packages/server/src/sessions.ts](../packages/server/src/sessions.ts), lines 52-354).

## Architectural reading

`CONTEXT.md` and handoff material establish vocabulary and investigation context, but they do not override executable behavior. This Bible follows the implementation when project guidance and current source differ.

The strongest existing seam is `AgentSessionServices` plus `TheosesSessionRuntime`: they make cwd/service ownership explicit. The main unresolved architectural question is whether the experimental remote server will eventually receive a first-party coding-agent service implementation; no such binding was verified in this pass ([packages/server/README.md](../packages/server/README.md), “This package does not provide a standalone CLI or coding-agent service”).
