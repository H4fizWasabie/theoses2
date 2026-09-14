# Features

Status below is evidence status, not product priority.

## Interaction modes — Verified

`main()` supports RPC, interactive, and print-like execution after argument parsing. Piped stdin changes an otherwise interactive invocation to print mode; RPC reserves stdin for its JSON-RPC path ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), `main`, lines 861-969). The argument surface, including model, session, tool, extension, trust, and output flags, is defined in [packages/coding-agent/src/cli/args.ts](../packages/coding-agent/src/cli/args.ts), `Args`/`parseArgs`/`printHelp`, lines 11-58 and 71-440.

RPC is a separate JSON-lines protocol over the coding-agent process. It supports prompting, steering/follow-up, abort, session/model/thinking/queue/compaction/retry/bash operations, state queries, exports, and extension UI request/response messages ([packages/coding-agent/src/modes/rpc/rpc-types.ts](../packages/coding-agent/src/modes/rpc/rpc-types.ts), `RpcCommand`/`RpcResponse`, lines 20-73 and 114-231; [packages/coding-agent/src/modes/rpc/rpc-mode.ts](../packages/coding-agent/src/modes/rpc/rpc-mode.ts), `runRpcMode`, lines 52-64 and 314-360).

## Sessions — Verified

Sessions are append-only JSONL files. The manager supports new, open, resume, fork, branch, import/export-related operations, session labels, channel keys, working notes, artifacts, and context reconstruction ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `SessionEntry` and `SessionManager`, lines 66-203 and 1030-1313).

## Agent turns and tools — Verified

The default SDK tool selection includes `read`, `bash`, `edit`, `write`, `working_note`, `note_operations`, `remember`, `save_note`, `recall_turns`, `convert_doc`, `web_search`, and `generate_image`; explicit allowlists, exclusion, `noTools`, and custom tools alter that set ([packages/coding-agent/src/core/sdk.ts](../packages/coding-agent/src/core/sdk.ts), `CreateAgentSessionOptions` and `createAgentSession`, lines 61-107 and 325-384). Tool calls can stream progress, run sequentially or in parallel, and produce tool-result messages ([packages/agent/README.md](../packages/agent/README.md), “With Tool Calls”).

The registry also defines the wider built-in surface, including PowerShell, grep, find, and ls variants. The read tool resolves paths, supports text or image reads, and truncates large text reads at 500 lines or 12 KiB. Bash runs a local child process, may rewrite commands through RTK unless disabled, enforces a timeout, and kills the process tree on abort; Theoses session variables are exposed only when the session option enables them. `convert_doc` shells out to the external `markitdown` executable and fails if it is unavailable ([packages/coding-agent/src/core/tools/index.ts](../packages/coding-agent/src/core/tools/index.ts), `ToolName`/`createAllToolDefinitions`, lines 126-223; [packages/coding-agent/src/core/tools/read.ts](../packages/coding-agent/src/core/tools/read.ts), schemas and `execute`, lines 21-69 and 209-364; [packages/coding-agent/src/core/tools/bash.ts](../packages/coding-agent/src/core/tools/bash.ts), RTK, process, timeout, and environment handling, lines 35-99 and 118-621; [packages/coding-agent/src/core/tools/convert-doc.ts](../packages/coding-agent/src/core/tools/convert-doc.ts), `createConvertDocToolDefinition`, lines 35-61).

## Memory — Verified

Semantic memory is file-backed Markdown with YAML frontmatter and typed edges. `remember` uses keyword matching plus a bounded one- or two-hop graph walk; it is deterministic and does not call an LLM ([packages/coding-agent/src/core/memory-store.ts](../packages/coding-agent/src/core/memory-store.ts), `FileMemoryStore`/`remember`, lines 200-339). Episodic memory is SQLite-backed and supports keyword search, time containment, nearest-time fallback, and recent retrieval ([packages/coding-agent/src/core/episodic-store.ts](../packages/coding-agent/src/core/episodic-store.ts), lines 28-162).

## Compaction and continuity — Verified

Active context is bounded to the last three user turns with associated assistant/tool messages. Compaction can be extension-controlled or default, appends a compaction entry, rebuilds context, and emits lifecycle events ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), `limitActiveContextMessages`/`buildContextEntries`, lines 437-545; [packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), compaction methods, lines 1996-2158).

## Extensions and resources — Verified

The runtime loads built-in and additional extensions, skills, prompt templates, and themes; project resources may require an explicit trust decision. Skills are discovered from user/project/default and explicit paths with ignore rules, frontmatter validation, collision diagnostics, source metadata, and model-invocation filtering; visible skills are rendered into the system prompt as escaped XML ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), runtime resource options and diagnostics, lines 702-831; [packages/coding-agent/src/core/skills.ts](../packages/coding-agent/src/core/skills.ts), `loadSkills`/`formatSkillsForPrompt`, lines 156-507). Diagnostics preserve extension-load failures and runtime settings diagnostics.

External tools can be loaded from HTTP sidecars or MCP servers over HTTP/stdio. Catalogs and schemas are validated, MCP requests use JSON-RPC session state, aborts are propagated, and returned values are marked as untrusted external content before entering the agent tool surface ([packages/coding-agent/src/core/tool-sources.ts](../packages/coding-agent/src/core/tool-sources.ts), `HttpSidecarToolSource`/`McpHttpToolSource`/`McpStdioToolSource`, lines 1-345).

## Dashboard and Telegram — Verified

The dashboard provides token-protected session/chat/file/memory APIs and SSE events ([packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), lines 57-115 and 334-554). Telegram restricts processing to the configured owner chat, serializes each chat queue, supports stop/model commands, stores non-image attachments as session artifacts, and triggers background consolidation/task-boundary work ([packages/telegram/src/index.ts](../packages/telegram/src/index.ts), lines 387-763).

## AI providers — Verified/partly inspected

The AI package has a provider-neutral `Models` collection, per-provider authentication/model catalogs, lazy API adapters, stream/completion/deferred operations, usage/cost calculation, reasoning controls, and a separate image-generation collection. The core boundary and auth precedence are documented in [19-ai-provider-architecture.md](19-ai-provider-architecture.md). Individual provider adapters and all provider-specific compatibility branches remain partly inspected.
