# Data model

## Session log

The session log is JSONL. A versioned header identifies the session, cwd, channel, and channel-session ID. Entries include user/assistant/tool messages, thinking/model changes, compaction, branch summaries, custom entries, labels, working notes, operation outcomes, promoted ranges, and artifacts ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `SessionEntry`, lines 66-203; header creation, lines 1030-1050).

The current session format is version `3`; migrations convert older IDs/tree metadata and old hook-message entries ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), migration constants/functions, lines 31-41 and 288-354).

## Context projection

Only message-like entries, custom messages, branch summaries, and compaction entries become model context. Plain custom entries remain durable metadata but do not enter the LLM context. The active context projection keeps the last three user turns plus related assistant/tool messages ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `sessionEntryToContextMessages`/`limitActiveContextMessages`, lines 437-483).

## Working Note

Working Note is a bounded per-session log entry used for curated short-term continuity. Appends drop old lines and hard-truncate an overlong single line; it is marked stale after more than five user turns. The configured injection cap is 2,000 characters ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), working-note methods, lines 31-41 and 1105-1182).

## Durable semantic memory

Memory nodes are Markdown files with YAML frontmatter: ID, type, subject, timestamp, edges, and body. Supported edge relations are `prefers`, `attributed_to`, `depends_on`, `located_at`, `requires`, `supersedes`, `used_in`, and `maintains` ([packages/coding-agent/src/core/memory-store.ts](../packages/coding-agent/src/core/memory-store.ts), `EDGE_RELATIONS`/`MemoryNode`, lines 8-41; serialization, lines 164-198). A legacy JSONL memory file can be migrated to per-node files ([packages/coding-agent/src/core/memory-store.ts](../packages/coding-agent/src/core/memory-store.ts), constructor migration, lines 200-236).

## Episodic memory

Episodes store a time range, summary, and related semantic node IDs in SQLite. Search is keyword-based; `atTime` returns a containing episode or nearest episode by time ([packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), lines 8-17 and 60-162). Database creation uses Node's built-in `node:sqlite`, so runtime support is a deployment constraint ([packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), `create`, lines 60-83).

## Artifacts

Session artifacts live under a per-session `artifacts/` directory. Stored files require positive size, use restrictive directory/file modes, and are catalogued with a bounded metadata list ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), artifact methods, lines 1216-1253).

## Configuration paths

The default identity is `.theoses` for project settings and `~/.theoses/agent` for the global agent directory; environment overrides are derived from the app name. Session files are under the agent directory's `sessions/<encoded cwd>` path ([packages/coding-agent/src/config.ts](../packages/coding-agent/src/config.ts), identity and paths, lines 479-599; [packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `getDefaultSessionDir`, lines 547-563).
