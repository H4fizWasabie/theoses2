# Glossary

| Term | Meaning in this repository | Source |
|---|---|---|
| Agent | Low-level stateful model/tool runner that emits lifecycle events | [packages/agent/src/agent.ts](../packages/agent/src/agent.ts), `Agent`, lines 216-388 |
| AgentSession | Product-facing session controller combining model, persistence, tools, hooks, compaction, and agent loop | [packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), class/events, lines 154-372 |
| AgentSessionRuntime | Cwd-bound owner of one current AgentSession and its services | [packages/coding-agent/src/core/agent-session-runtime.ts](../packages/coding-agent/src/core/agent-session-runtime.ts), lines 69-117 |
| Active Context Window | Current model projection, bounded to the last three user turns plus associated messages | [CONTEXT.md](../CONTEXT.md), lines 1-80; [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 468-483 |
| Channel | Transport identity such as `cli`, `dashboard`, or `telegram` | [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 43-64 |
| Channel Session ID | Transport-specific identity used to map a conversation to a durable session | [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 43-64 and 1105-1111 |
| Durable Memory | Shared semantic memory stored as typed node files and relations | [packages/coding-agent/src/core/memory-store.ts](../packages/coding-agent/src/core/memory-store.ts), lines 8-41 and 200-339 |
| Episode | Time-ranged summarized event stored in SQLite | [packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), lines 8-17 |
| Working Note | Bounded per-channel/session continuity note stored in the session log | [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 1105-1182 |
| Session Manager | JSONL persistence, context projection, branching, artifacts, channel lookup, and session listing owner | [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 933-1965 |
| Model Runtime | Coding-agent service that resolves models, auth, catalogs, and runtime provider configuration | [packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), lines 225-487 |
| Resource Loader | Loader for extensions, skills, templates, themes, and context resources | [packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 702-768 |
| Steering | Input queued into an active streaming run | [packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), lines 1424-1463 |
| Follow-up | Input held for a later turn after the current run reaches its boundary | [packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), lines 1445-1463 |
| Session Lease | Client-side shared/exclusive ownership handle for an attached remote session | [packages/client/src/client.ts](../packages/client/src/client.ts), lease methods, lines 145-310 |
