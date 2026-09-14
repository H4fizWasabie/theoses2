# Repository map

## Top-level structure

| Path | Responsibility | Evidence |
|---|---|---|
| `packages/agent` | Stateful low-level agent and turn loop | `Agent` and loop exports in [packages/agent/src/agent.ts](../packages/agent/src/agent.ts), lines 173-388; loop in [packages/agent/src/agent-loop.ts](../packages/agent/src/agent-loop.ts), lines 27-275 |
| `packages/ai` | Provider APIs, models, auth, streaming, usage | package README, “Supported Providers” and “Quick Start”; public exports in [packages/ai/src/index.ts](../packages/ai/src/index.ts), lines 1-51 |
| `packages/coding-agent` | Product runtime, CLI, sessions, tools, memory, modes, extensions | [packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), lines 225-487; [packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 920-970 |
| `packages/client` | Transport-neutral remote client and session leases | [packages/client/src/client.ts](../packages/client/src/client.ts), `TheosesClient`, lines 26-180; package README |
| `packages/dashboard` | HTTP/SSE dashboard adapter and file/memory endpoints | [packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), lines 334-554 |
| `packages/evals` | Evaluation harnesses and smoke/eval extensions | package manifest and `packages/evals/src/` |
| `packages/protocol` | Strict schemas, AI-to-wire mapping, CBOR framing | [packages/protocol/src/schemas.ts](../packages/protocol/src/schemas.ts), lines 1-450; [packages/protocol/src/codec.ts](../packages/protocol/src/codec.ts), lines 1-180 |
| `packages/server` | Authenticated-listener-agnostic session server core | [packages/server/src/server.ts](../packages/server/src/server.ts), `TheosesServer`, lines 33-395; [packages/server/src/sessions.ts](../packages/server/src/sessions.ts), lines 52-354 |
| `packages/telegram` | grammY owner bot adapter | [packages/telegram/src/index.ts](../packages/telegram/src/index.ts), lines 387-773 |
| `packages/telemetry` | Vendor-neutral explicit telemetry contracts | package README, “Telemetry Concepts” and “Adapter Contract” |
| `packages/tui` | Terminal rendering/components/input | package README, “Features” and “TUI interface and renderers” |
| `docs/` | ADRs, agent instructions, research | [CONTEXT.md](../CONTEXT.md), lines 1-120; `docs/adr/` |
| `.theoses/` | Project-local extensions, prompts, skills, and resources | tracked files under `.theoses/`; loader integration in [packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 702-768 |

## Important roots

`packages/*/src` is implementation; `packages/*/test` is package-level verification; `packages/coding-agent/examples` is extension/example material; `packages/coding-agent/docs` is product documentation and screenshots. Root package scripts define build/check/test/release entrypoints ([package.json](../package.json), `scripts`, lines 1-95).

## Dependency direction

The intended direction is `ai` → `agent` → `coding-agent`, with protocol/client/server as a separate remote boundary. The server imports protocol types and accepts a service interface rather than importing the coding-agent runtime ([packages/server/src/types.ts](../packages/server/src/types.ts), lines 1-62). The coding-agent SDK imports agent/AI/tool/runtime concerns ([packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), lines 1-43).

## Generated and non-source surfaces

The tracked inventory contains 1,344 files: 609 source files, 500 test/fixture files, 92 documentation/text files, 71 configuration/resource files, 62 explicitly excluded artifacts, and 10 other files. These are inventory categories, not semantic package boundaries; the exact per-path classification and exclusion reasons are in [14-file-inventory.md](14-file-inventory.md).
