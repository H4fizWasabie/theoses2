# Theoses2

Theoses2 adapts the coding-agent harness into a long-lived personal-assistant engine: autonomous, full-capability, bounded at the model-context boundary, with durable memory shared across channels.

## Language

**Channel Session**:
The persistent conversational state for one channel (Telegram, CLI, dashboard WebUI) for one user. Each channel keeps its own history and Active Context Window; only durable memory is shared across channels. Implemented for Telegram and the dashboard by `core/channel-session.ts` (open-or-create by channel key, thinking-level policy, one turn at a time, stop, model switch); adapters only render.
_Avoid_: session (ambiguous with the engine's own session log), conversation

**Active Context Window**:
The last three turns (six user/assistant messages) of a Channel Session's history, sent to the model on every turn. Fixed by turn count, not token count.
_Avoid_: active context, recent history

**Working Note**:
A bounded, per-Channel-Session, curated text artifact holding facts a turn must not re-discover (confirmed paths, methods, open discrepancies). Written by explicit model action, plus one automatic `ran: <command>` entry per bash command; injected every turn labeled non-authoritative ("verify only if contradictory"). Distinct from the Active Context Window (raw recent turns) and from Durable Memory (the shared, pull-based fact store) — the Working Note is the narrow, curated middle layer between them.
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

**Turn Settlement**:
The fire-and-forget work that runs after a Channel Session turn ends successfully (memory consolidation, task-boundary detection). It never blocks or fails the reply. Triggered by the Channel Session itself when an operation finishes with outcome `completed` and no retry is pending; adapters never trigger it. Only non-CLI Channel Sessions (Telegram, dashboard) settle. Plain CLI coding runs still reach Durable Memory, but only through compaction distillation of the turns compaction drops.
_Avoid_: post-turn hook (implies an event seam that doesn't exist), background turn work

**Compaction Run**:
One execution of context compaction, from preparation to `compaction_end`, whether triggered manually (`/compact`, RPC, extensions) or automatically (overflow, threshold, turns). Owns the `session_before_compact` and `session_compact` hooks, the summarizer call, appending the compaction entry, rebuilding message state, and every `compaction_end` / `session_compact_failed` event, including failures that never started a run. The trigger decision and overflow-retry bookkeeping stay with the Channel Session's engine, not the run. Distinct from the pure summarizer in `compaction/compaction.ts`.
_Avoid_: compaction pass, compact job

**Tool Registry**:
The session's set of available tools, built from built-in, SDK, external (sidecar, MCP) and extension sources, plus the rule that decides which of them are active: allow/exclude lists, external tools deferred behind `tool_search`, `taskPlan.enabled` hiding `task_plan`. Implemented by `core/tool-registry.ts`. It does not own the active set (the engine's Agent does) and does not execute tools beyond routing `tool_call`: a refresh returns the names that should be active and the session applies them.
_Avoid_: tool manager, tool catalog

**Task Plan**:
The list of every piece of a change plus the check that proves it, kept by the model through the `task_plan` tool, which the model chooses to use or not: the harness never blocks a file change for lack of a plan and never holds a run open for open items. A plan the model does keep is held to its own rules: a verify item closes only after a check command passed since the last file change, and open or deferred items show in the status line under the final reply. A `fix` plan starts with root cause, siblings and fix scope. Persisted as `task_plan` custom entries in the session log (latest wins), so it survives restarts. Distinct from the Working Note, which records facts; the Task Plan records obligations.
_Avoid_: todo list, checklist

**Plan Review**:
One independent review of a finished Task Plan (fixes and multi-item changes), by a sub-agent with fresh context and a different model family (`backgroundModels.reviewer`), which can read the codebase. Must-fix findings go back to the worker once; the result shows in the plan status line.
_Avoid_: code review (that is the human PR review), second opinion

**Auto-Resume**:
The one automatic follow-up a Telegram turn gets when it still ends on a provider error after the session's own retries: after 60 seconds the same task is re-prompted with an "[automatic resume]" message that settles no text. A new owner turn or /stop cancels it; a resume that fails again is reported and not resumed.
_Avoid_: retry (that is the session's own per-request retry), auto-continue

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
