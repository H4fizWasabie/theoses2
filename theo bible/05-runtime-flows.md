# Runtime flows

## CLI startup and first prompt

```text
argv + TTY
  → parse mode/session flags
  → locate session and final cwd
  → load trust/settings/resources/models
  → create AgentSessionRuntime
  → choose RPC, TUI, or print
  → prompt AgentSession
  → Agent loop streams model/tool events
  → session manager persists durable entries
```

The mode and session selection are implemented in [packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), `main`, lines 570-669. Runtime construction and trust/resource resolution are in lines 693-839. Final dispatch is in lines 920-969.

## Prompt preparation

`AgentSession.prompt` handles extension-command interception, input transformation, skill/template expansion, abort notices, reply context, clock annotation, streaming queue behavior, pending bash completion, model/auth checks, context capping, system prompt rebuild, and the `before_agent_start` hook before entering the agent loop ([packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), prompt flow, lines 1191-1362).

The shared `Agent` owns the run lifecycle and delegates each prompt/continuation to the low-level loop. The loop emits user/message/turn/agent events, transforms coding-agent messages into provider messages only at the LLM boundary, drains steering before follow-up queues, and executes assistant tool calls with sequential or parallel policy, validation, before/after hooks, abort/error normalization, and ordered tool-result history ([packages/agent/src/agent.ts](../packages/agent/src/agent.ts), `Agent.run*`/`processEvents`, lines 155-592; [packages/agent/src/agent-loop.ts](../packages/agent/src/agent-loop.ts), `runLoop`/tool execution, lines 88-828).

## Model/tool turn

The low-level loop emits agent and turn lifecycle events, streams the assistant response, executes tool calls, appends tool results, polls steering/follow-up queues, and either starts another turn or emits `agent_end` ([packages/agent/src/agent-loop.ts](../packages/agent/src/agent-loop.ts), `runAgentLoop`/`runLoop`, lines 27-275). `Agent` subscribers are awaited in registration order, so event consumers can affect when a run is considered settled ([packages/agent/src/agent.ts](../packages/agent/src/agent.ts), subscription and idle behavior, lines 240-329).

## RPC command lifecycle

The RPC mode takes JSON lines from stdin, dispatches typed commands, writes correlated JSON-line responses/events to stdout, and applies output backpressure. It rebinds extensions when the runtime switches session. Extension dialogs use request IDs with abort/default-value and timeout cleanup; unsupported TUI-only operations degrade to no-ops or explicit unsupported responses ([packages/coding-agent/src/modes/rpc/rpc-mode.ts](../packages/coding-agent/src/modes/rpc/rpc-mode.ts), `runRpcMode`/`createDialogPromise`/extension UI context, lines 52-132 and 138-308; [packages/coding-agent/src/modes/rpc/rpc-types.ts](../packages/coding-agent/src/modes/rpc/rpc-types.ts), lines 20-73 and 237-260).

## Dashboard message

The dashboard opens or reuses a dashboard-channel session, serializes messages per session, subscribes to session events, emits SSE `delta`, `tool_call`, `tool_result`, and `usage` events, calls `session.prompt`, then emits `done` or `error`. Consolidation/task-boundary work is started after the response path ([packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), `dashboardSession`/`streamChat`, lines 282-404).

## Telegram message

Telegram filters to the owner chat, handles stop/model commands, enqueues normal messages per chat, loads the session, downloads images/documents with size limits, prompts with reply context and images, edits status messages, sends text/images, and schedules background memory/task-boundary work ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), `createTelegramBot`, lines 440-763). The queue promise is intentionally not awaited by grammY so a later stop update can be dispatched while the active turn continues ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), lines 744-762).

## Remote protocol request

Client connect: create a fresh transport, send `hello`, receive and apply the server snapshot, then expose request/session APIs. Requests are correlated by IDs; session acquisition uses shared/exclusive local leases and sends `attach`/`detach` as needed ([packages/client/src/connection.ts](../packages/client/src/connection.ts), lines 45-226; [packages/client/src/client.ts](../packages/client/src/client.ts), lines 70-310). Server connect: decode frames, require hello/version, send snapshot, execute commands through `LiveSessionManager`, and return structured response envelopes ([packages/server/src/server.ts](../packages/server/src/server.ts), lines 99-281; [packages/server/src/sessions.ts](../packages/server/src/sessions.ts), lines 52-125).
