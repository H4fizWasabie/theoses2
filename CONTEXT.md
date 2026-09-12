# Theoses2

Theoses2 adapts the coding-agent harness into a long-lived personal-assistant engine: autonomous, full-capability, bounded at the model-context boundary, with durable memory shared across channels.

## Language

**Channel Session**:
The persistent conversational state for one channel (Telegram, CLI, dashboard WebUI) for one user. Each channel keeps its own history and Active Context Window; only durable memory is shared across channels.
_Avoid_: session (ambiguous with the engine's own session log), conversation

**Active Context Window**:
The last three turns (six user/assistant messages) of a Channel Session's history, sent to the model on every turn. Fixed by turn count, not token count.
_Avoid_: active context, recent history

**Working Note**:
A bounded, per-Channel-Session, curated text artifact holding facts a turn must not re-discover (confirmed paths, methods, open discrepancies). Written only by explicit model action; injected every turn labeled non-authoritative ("verify only if contradictory"). Distinct from the Active Context Window (raw recent turns) and from Durable Memory (the shared, pull-based fact store) — the Working Note is the narrow, curated middle layer between them.
_Avoid_: current working context (the ticket's working title, not the canonical term — CWC is the Active Context Window plus the Working Note together, not a thing in itself), session note, scratchpad

**Durable Memory**:
The semantic/episodic fact store shared across all of a user's Channel Sessions, retrieved only through explicit `remember`-style tools, never injected wholesale.
_Avoid_: long-term memory, graph memory

**Working Note Entry**:
The unit of change to a Working Note: one model-invoked append, persisted as its own record type in the engine's existing session log (not a separate store), so the engine's reducer-replay already recovers it on restart.
_Avoid_: session note entry, note record

**Abort Notice**:
A rendering rule, not stored state: when the most recent operation's outcome is `aborted` (the engine's existing `OperationFinishedRecord`), the next turn's prompt is prefixed with an explicit notice that the prior task was cancelled and should not be resumed. No new persistence — reuses the engine's existing abort/outcome records.
_Avoid_: stop marker, boundary marker

**Owner**:
The single human who controls a Theoses2 runtime across its channels. Theoses2 has one owner, not a user directory or role hierarchy.
_Avoid_: account, tenant, operator

**Channel Access**:
The boundary that proves a request comes from the owner through a particular channel. Telegram uses the configured owner chat ID; the dashboard uses an owner credential.
_Avoid_: network trust, session identity

**Owner Telegram ID**:
The numeric Telegram identifier that authorizes the owner's private chat with Theoses2. For a private chat, this is the same value as the Telegram chat ID used by the runtime.
_Avoid_: Telegram username, display name, phone number

**Delegated Coding Agent**:
A coding agent operating on the owner's behalf, normally against an isolated development or test runtime rather than as a separate Theoses2 owner.
_Avoid_: dashboard user, Theoses2 account
