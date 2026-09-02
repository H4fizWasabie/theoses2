# Pi Capability Inventory

This is a factual, descriptive inventory of the capabilities currently implemented across `packages/` in the Pi coding-agent harness (v0.84.3), produced to unblock GitHub issue [#4](https://github.com/H4fizWasabie/theoses2/issues/4) ("Pi capability inventory"), a child of the Theoses2 engine map (issue [#1](https://github.com/H4fizWasabie/theoses2/issues/1)). It does not recommend what to keep, cut, or refactor for Theoses2 — it only records what exists, where it lives, and what it obviously assumes about a coding/terminal/git environment. All file paths are relative to `packages/` unless given in full; every capability was verified against source in this repo.

---

## packages/agent (`theoses-agent-core`)

Description (package.json): "General-purpose agent with transport abstraction, state management, and attachment support." This package is the most domain-neutral of the monorepo — it defines the agent loop, message/event model, and session persistence abstractions, with only a thin set of default tools that happen to be coding-oriented.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| Core agent loop (turns, streaming, tool orchestration) | `agent/src/agent.ts`, `agent/src/agent-loop.ts`, `agent/src/types.ts` | Stateful `Agent` class and low-level `agentLoop()`/`agentLoopContinue()` generator driving prompt → LLM stream → tool execution → follow-up turns; emits a typed event stream (`agent_start`, `turn_start`, `message_update`, `tool_execution_*`, `agent_end`). | None — model/tool/message agnostic. |
| Steering & follow-up message queues | `agent/src/agent.ts` (`steer`, `followUp`, `clearSteeringQueue`, etc.) | Lets a caller interrupt a running turn (steering) or queue work for after the turn completes (follow-up), each with "one-at-a-time" or "all" delivery modes. | None. |
| Tool execution hooks | `agent/src/agent.ts`, `agent/src/types.ts` | `beforeToolCall`/`afterToolCall` hooks can block, mutate, or terminate tool execution; parallel vs sequential execution modes, globally or per-tool. | None. |
| Custom message types via declaration merging | `agent/src/harness/messages.ts`, `agent/src/types.ts` | `AgentMessage` union is extensible via `CustomAgentMessages` interface merging, letting apps add UI-only message roles filtered out by `convertToLlm`. | None. |
| Agent harness (system prompt, prompt templates, result types) | `agent/src/harness/agent-harness.ts`, `agent/src/harness/system-prompt.ts`, `agent/src/harness/prompt-templates.ts`, `agent/src/harness/result.ts` | Higher-level harness wrapping the raw loop with a default system prompt, prompt-template expansion, and structured `Result`/error types. | `system-prompt.ts` defaults imply a coding assistant persona (not yet confirmed generic-persona-neutral; template file loading is filesystem-based). |
| Session tree/log storage abstraction | `agent/src/harness/session/session.ts`, `session/types.ts`, `session/context.ts`, `session/state.ts`, `session/memory.ts`, `session/jsonl/` | `Session`/`SessionTree` model: branching entry log (id/parentId), in-memory and JSONL-backed storage, `SessionStorage` interface, branch bounds, entry queries. Backend-agnostic (SQLite backend lives in a separate package). | Generic append-only branching log; not coding-specific itself, but built to store agent conversation/tool-call history, and JSONL storage backend writes to the filesystem. |
| Session search | `agent/src/search/index.ts`, `search/scanning.ts` | `SessionSearch` interface plus a linear "scanning" implementation for searching session entries by text. | None. |
| Context compaction / summarization | `agent/src/harness/compaction/compaction.ts`, `compaction/branch-summarization.ts`, `compaction/utils.ts` | Summarizes older messages via an LLM call when context grows large; extracts file-operation summaries from tool-result history for compaction prompts. | `extractFileOperations()` in `compaction.ts` specifically parses read/write/edit tool results — assumes file-editing tools exist in the transcript. |
| Skills loading | `agent/src/harness/skills.ts` | Loads `SKILL.md`-style skill files (per agentskills.io convention) from directories, with frontmatter parsing, `.gitignore`-style ignore-file honoring, and diagnostics. | Filesystem-directory based; ignore-file support (`.gitignore`, `.ignore`, `.fdignore`) assumes a repo-like directory tree. |
| Default coding tools | `agent/src/harness/tools/{bash,read,write,edit,edit-diff}.ts`, `tools/file-mutation-queue.ts`, `tools/image.ts` | Bash shell-execution tool, file read/write/edit tools with unified-diff-based edit application (`edit-diff.ts`), an image tool, and a mutation queue to serialize concurrent file writes. | Directly coding/filesystem-centric: assumes a local filesystem workspace, a shell, and diff/patch-style file editing. |
| Node execution environment adapter | `agent/src/harness/env/nodejs.ts`, `agent/src/node.ts` | `NodeExecutionEnv` implements `ExecutionEnv` (file I/O, process spawn, path resolution) on top of Node's `fs`/`child_process`; separates env from tool logic so tools can run against other backends. | Node/filesystem/process-specific, but cleanly abstracted behind `ExecutionEnv`. |
| Output truncation & shell-output capture utilities | `agent/src/harness/utils/truncate.ts`, `utils/shell-output.ts` | Caps tool output size/line count for LLM context budgets; captures and formats shell stdout/stderr. | Shell-output capture assumes a subprocess/terminal execution model. |
| Telemetry instrumentation hooks | `agent/src/harness/telemetry.ts` | Emits structured telemetry spans/attributes (turn start/end, tool timings, tokens) via the `theoses-telemetry` contract. | None. |
| LLM streaming proxy | `agent/src/proxy.ts`, `agent/src/stream-fn.ts` | `streamProxy()` lets a browser/thin client proxy LLM calls through a backend server rather than calling providers directly. | None. |

---

## packages/coding-agent (`theoses-coding-agent`)

Description (package.json): "Coding agent CLI with read, bash, edit, write tools and session management." This is the flagship product package: the `pi` CLI, its four interaction modes (interactive/print/JSON/RPC), extension and package systems, and all coding-specific tools. It is the most heavily coding/terminal/git-coupled package in the monorepo.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| CLI entry & argument parsing | `coding-agent/src/cli/args.ts`, `cli/*.ts`, `bin` = `dist/bundle/cli.js` | Parses `pi [options] [@files...] [messages...]`; dispatches to interactive/print/json/rpc modes and package subcommands (`install`, `update`, `list`, `config`). | `@files` file-attachment syntax, `pi update --models`, and package commands assume a dev-tool CLI usage pattern. |
| Four run modes | `coding-agent/src/modes/index.ts`, `modes/interactive/interactive-mode.ts` (221K, largest file), `modes/json-event.ts`, `modes/print-mode.ts`, `modes/rpc/rpc-mode.ts` | Interactive TUI mode, one-shot print mode (`-p`), JSON-event streaming mode, and RPC mode (stdin/stdout, LF-delimited JSONL) for embedding pi as a subprocess in other tools. | Interactive mode is a terminal UI (built on `pi-tui`); RPC/JSON modes are transport-neutral and reusable for a non-terminal assistant. |
| Agent session runtime | `coding-agent/src/core/agent-session.ts` (114K, largest source file), `core/agent-session-runtime.ts`, `core/agent-session-services.ts` | Wraps `pi-agent-core`'s `Agent` with session persistence, model/thinking-level state, tool wiring, and lifecycle management; `createAgentSession()`/`createAgentSessionRuntime()` are the public SDK entry points (also exported for embedding). | Not inherently coding-specific at the API level, but composed almost entirely of coding tools/extensions by default. |
| Default coding tools (extended) | `coding-agent/src/core/tools/{bash,edit,edit-diff,find,grep,ls,powershell,read,write}.ts` | Superset of the agent-core tools: adds `find`, `grep`, `ls`, and a PowerShell variant of bash for Windows; unified-diff based edit tool; output truncation and rendering helpers. | Directly filesystem/shell-centric: assumes a local project directory tree, `grep`/`find`-style search, and a POSIX or PowerShell shell. |
| Session management & storage | `coding-agent/src/core/session-manager.ts` (52K), `core/session-cwd.ts`, `core/session-export.ts` | Manages JSONL session files under `~/.theoses/agent/sessions/`, organized by working directory; `--continue`, `--session`, `--fork`, `--no-session`, export/import to HTML/JSONL. `session-cwd.ts` explicitly errors when a session's stored `cwd` no longer exists on disk. | Strongly coupled to "a session belongs to a filesystem project directory" — sessions are indexed and validated by working directory. |
| Session branching / tree navigation | via `core/agent-session.ts`, interactive `/tree`, `/fork`, `/clone` commands (README: Sessions → Branching) | In-place branching session tree (entries have `id`/`parentId`); UI lets users jump to any point and continue from there. | UI-level (`/tree`) is terminal-specific, but the underlying tree model (in `pi-agent-core`) is not. |
| Context compaction (product layer) | `coding-agent/src/core/compaction/` | Wraps `pi-agent-core` compaction with product-level triggers (`/compact`, automatic on overflow) and settings. | None beyond agent-core's coupling. |
| Extension system | `coding-agent/src/core/extensions/{types.ts (61K), loader.ts, runner.ts (37K), wrapper.ts, index.ts}` | TypeScript-module extension API (`ExtensionAPI`): register tools, commands, keybindings, event handlers (`tool_call`, `message_end`, `tool_result`, `user_bash`, `project_trust`, session shutdown, etc.), and UI components/overlays. Loaded from `~/.theoses/agent/extensions/`, `.theoses/extensions/`, or packages. | Extension API types import TUI component types (`Component`, `EditorComponent`, `KeyId`, `Theme`) directly, coupling "extension" to "adds terminal UI," plus bash-result and git-trust concepts. |
| Package manager (pi packages) | `coding-agent/src/core/package-manager.ts` (83K, largest core file), `core/pi-manifest.ts`, `utils/git.ts` | Installs/updates/removes shareable bundles of extensions/skills/prompts/themes from npm or git sources (`pi install npm:...`, `git:...`, `ssh://...`); resolves git URLs, runs `npm install --omit=dev` for git packages, tracks pinned refs. | Deeply coupled to npm/git-package distribution model — assumes packages are npm packages or git repos with `package.json`/`pi` manifest fields. |
| Project trust | `coding-agent/src/core/project-trust.ts`, `core/trust-manager.ts` | Per-directory trust prompt/decision store (`~/.theoses/agent/trust.json`) gating whether `.theoses/settings.json`, project extensions, and project packages load; walks up parent directories. | Directly modeled around "project = a directory on disk," parallel to a git-repo trust model (e.g., VS Code workspace trust). |
| Skills (product layer) | `coding-agent/src/core/skills.ts` | Product-level skill loading/invocation (`/skill:name`) built on `pi-agent-core`'s skill loader, with additional directory search paths (`.agents/skills`, `.theoses/skills`). | Filesystem-directory based, same as agent-core. |
| Prompt templates | `coding-agent/src/core/prompt-templates.ts` | Loads Markdown prompt templates from `~/.theoses/agent/prompts/` or `.theoses/prompts/`, expandable via `/name` with `{{variable}}` substitution. | Filesystem-based; not coding-specific in concept. |
| Model runtime, resolver, registry, config | `coding-agent/src/core/model-runtime.ts` (28.5K), `core/model-resolver.ts` (25.7K), `core/model-registry.ts`, `core/model-config.ts`, `core/models-store.ts`, `core/remote-catalog-provider.ts` | Resolves and caches available models/providers from `pi-ai`, handles scoped-model cycling (`/scoped-models`, Ctrl+P), custom provider config via `~/.theoses/agent/models.json`. | None specific to coding; generic LLM provider/model management. |
| Auth & credential storage | `coding-agent/src/core/auth-storage.ts` (16K), `core/auth-guidance.ts`, `cli/auth-check.ts`, `cli/auth-command.ts`, `cli/credential-print.ts` | `/login`/`/logout` flows, OAuth and API-key storage for ~15 subscription/API providers, credential printing for debugging. | None. |
| Settings & keybindings | `coding-agent/src/core/settings-manager.ts` (42K), `core/keybindings.ts` (12K), `core/resolve-config-value.ts`, `core/settings-diagnostics.ts` | Layered global (`~/.theoses/agent/settings.json`) + project (`.theoses/settings.json`) settings; fully remappable keybindings (`~/.theoses/agent/keybindings.json`). | Project-layer settings assume a project directory; keybindings are terminal-input-specific. |
| Context files (AGENTS.md/CLAUDE.md loading) | `coding-agent/src/core/resource-loader.ts` (39K) | Loads and concatenates `AGENTS.md`/`CLAUDE.md`/`AGENTS.override.md` from global, parent-directory, and cwd locations into the system prompt; supports `.theoses/SYSTEM.md` overrides. | Directory-tree walk from cwd upward — assumes a nested project directory structure (git-repo-like). |
| Git integration | `coding-agent/src/utils/git.ts`, `core/footer-data-provider.ts` (`findGitPaths`, HEAD/branch watching) | Parses git remote URLs (for package installs) and reads `.git/HEAD` directly (walking up from cwd, handling worktrees) to show current branch in the footer UI. | Explicit, hard assumption of a git repository for both package installs and the status footer. |
| Bash/PowerShell execution & shell utilities | `coding-agent/src/core/bash-executor.ts`, `core/exec.ts`, `utils/shell.ts`, `utils/child-process.ts` | Executes shell commands with capture, timeout, and streaming update support; platform-specific shell selection (bash vs PowerShell). | Terminal/OS-shell-specific by definition. |
| HTML session export | `coding-agent/src/core/export-html/{index.ts, tool-renderer.ts, template.html/css/js, vendor/}` | Renders a session transcript (including tool calls/diffs) to a static, styled HTML file (`/export`) with syntax highlighting and diff rendering. | `tool-renderer.ts` renders coding-tool output (diffs, file paths) specifically. |
| Session sharing | `coding-agent/src/modes/interactive/session-share.ts` | `/share` uploads a session as a private GitHub gist with a shareable HTML link. | Hard dependency on GitHub as the sharing target. |
| RPC client/server protocol | `coding-agent/src/modes/rpc/{rpc-mode.ts (23K), rpc-client.ts (17K), rpc-types.ts, jsonl.ts}`, `src/client/{index.ts, remote-session.ts, transcript.ts}` | Newline-delimited JSON-RPC-like protocol for driving pi as a subprocess from another process/language; typed client for consuming it. | Transport itself is generic; message vocabulary mirrors coding-agent's tool/session model. |
| Local session server bootstrap | `coding-agent/src/server/create-harness.ts` | Constructs an `AgentHarness`/session suitable for serving over `pi-server`'s protocol. | None beyond the underlying session model. |
| Image handling (paste/clipboard/resize) | `coding-agent/src/utils/{clipboard.ts, clipboard-image.ts, clipboard-native.ts, image-*.ts, exif-orientation.ts}` | Captures clipboard images (Ctrl+V) or drag-and-drop, resizes/converts/orients them for LLM image input, uses a worker thread for resizing. | Terminal-clipboard and terminal-drop-target specific; also relevant to a chat-style personal assistant (image attachments) with adaptation. |
| llama.cpp router integration | `coding-agent/src/extensions/llama/` | Built-in extension for `/llama` command: download/load/unload local llama.cpp-served models. | None coding-specific; local-inference-server integration. |
| Windows self-update / version checks | `coding-agent/src/utils/{windows-self-update.ts, version-check.ts, changelog.ts}` | Checks `pi.dev/api/latest-version`, self-updates the Windows binary, displays `/changelog`. | CLI-binary distribution model, not coding-specific per se. |
| Autocomplete / file reference in editor | `coding-agent/src/modes/interactive/components/` (via `pi-tui` `AutocompleteProvider`) | `@`-triggered fuzzy file search and Tab path completion in the prompt editor. | Directly assumes a filesystem workspace to search over. |

---

## packages/tui (`theoses-tui`)

Description (package.json): "Terminal User Interface library with differential rendering for efficient text-based applications." Fully generic terminal UI toolkit — no coding-specific concepts live here, but by construction it only targets terminal (TTY) output.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| TUI renderers | `tui/src/tui.ts`, `tui-main-screen.ts`, `tui-alt-screen.ts` | Shared `TUI` interface with two renderer implementations: main-screen (preserves scrollback) and alt-screen (app-owned fixed-height viewport with scrolling). | None coding-specific; inherently terminal-only (not adaptable to a web/Telegram UI without a new renderer). |
| Differential rendering & synchronized output | `tui/src/tui.ts`, `layout.ts`, `layout-node.ts` | Renders only changed lines/rows; uses CSI 2026 synchronized-output escape sequences to avoid flicker. | Terminal-escape-sequence specific. |
| Editor component (multi-line text input) | `tui/src/editor-component.ts`, `components/editor.ts` (78K, largest file) | Full-featured text editor widget: undo/redo (`undo-stack.ts`), kill-ring (`kill-ring.ts`), word navigation, autocomplete, external-editor handoff. | None conceptually coding-specific, though sized/tuned for a coding-agent prompt box. |
| Built-in component library | `tui/src/components/{text,truncated-text,input,markdown,loader,select-list,settings-list,spacer,image,box,container? ,h-stack,v-stack,scroll-view,cancellable-loader,alt-screen-flash}.ts` | Standard widget set: text, markdown rendering, selection lists, settings lists, progress loaders, image rendering, layout stacks, scrollable regions. | None. |
| Inline image rendering | `tui/src/components/image.ts`, `terminal-image.ts` | Renders images via Kitty or iTerm2 terminal graphics protocols. | Terminal-graphics-protocol specific — would not work in a non-terminal channel (e.g. Telegram/WebUI) without replacement. |
| Autocomplete framework | `tui/src/autocomplete.ts`, `fuzzy.ts` | Generic fuzzy-match autocomplete provider interface, used by coding-agent for file-path and slash-command completion. | None itself; consumer (coding-agent) supplies coding-specific providers. |
| Keybinding matching | `tui/src/keybindings.ts`, `keys.ts`, `native-modifiers.ts` | Parses/matches key chords (`matchesKey(data, "ctrl+x")`) across platforms, including native key-modifier detection modules. | Terminal-input specific. |
| Native modules (Windows/macOS) | `tui/native/win32/`, `tui/native/darwin/` | Prebuilt native `.node` addons for terminal-specific behavior (e.g., Windows console modifier-key detection). | Platform/terminal-native code. |
| Terminal abstraction | `tui/src/terminal.ts`, `terminal-colors.ts`, `stdin-buffer.ts` | `ProcessTerminal` and related abstractions over raw stdin/stdout, ANSI color handling, bracketed paste mode. | Terminal-only by definition. |
| LaTeX rendering helper | `tui/src/latex.ts` | Renders LaTeX math expressions for terminal display (used in markdown component). | None coding-specific. |

---

## packages/session-backends/sqlite-node (`theoses-session-backend-sqlite-node`)

Description (README): "Node sqlite session backend for `theoses-agent-core` sessions. Provides the `node:sqlite` adapter, SQLite session repository, migrations, materialized views, and optional FTS search."

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| SQLite session repository | `sqlite-node/src/sqlite/repo.ts`, `sqlite/index.ts` | Implements `pi-agent-core`'s `SessionStorage`/repository contract against SQLite instead of JSONL files; lazily owns a single shared DB connection. | None — generic append-only session log storage. |
| Schema migrations | `sqlite-node/src/sqlite/migrations.ts` | Versioned SQL migrations for the session database schema. | None. |
| Branch materialization / caching | `sqlite-node/src/sqlite/branch-cache.ts` | Maintains materialized views/caches for efficient branch-bounds queries over the session tree. | None. |
| Full-text search backend | `sqlite-node/src/sqlite/search-backend.ts` | Implements `pi-agent-core`'s `SessionSearch` via SQLite FTS tables, created lazily on first non-blank search and kept in sync by triggers. | None. |
| `node:sqlite` adapter | `sqlite-node/src/sqlite/types.ts`, `sqlite/sql.ts` | Adapts Node's built-in `node:sqlite` module to the `SqliteDatabase` interface expected by the repository, decoupling the schema/query layer from the runtime SQLite binding. | Node-runtime specific (not browser-portable), but not coding-specific. |

---

## packages/ai (`theoses-ai`)

Description (package.json): "Unified LLM API with automatic model discovery and provider configuration." Entirely provider/model-layer; no coding-specific concepts.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| Unified streaming/completion API | `ai/src/index.ts`, `api/` dir | `streamSimple`/`completeSimple` and lower-level `stream`/`complete` across ~30 providers with a single request/response shape; unifies thinking/reasoning, tool calls, and stop reasons across providers. | None. |
| Provider registry & model catalog | `ai/src/models.ts`, `models.generated.ts` (generated, do-not-edit-directly per AGENTS.md), `model-catalog.ts`, `models-store.ts` | `createModels()`/`Models` class for registering providers and querying tool-capable models; static + dynamic (remote-refreshed) catalogs. | None. |
| Auth resolution & credential store | `ai/src/auth/`, `auth/oauth/` | Resolves API keys/OAuth tokens per provider from env vars or a credential store; OAuth login flows (e.g., Anthropic subscription, GitHub Copilot, Vertex AI). | None. |
| Provider implementations | `ai/src/providers/` | Concrete provider adapters (OpenAI, Anthropic, Google, Bedrock, Azure, Mistral, Groq, OpenRouter, etc.) translating the unified API to each vendor's wire format. | None. |
| Image generation API | `ai/src/images.ts`, `image-models.ts`, `image-models.generated.ts`, `images-api-registry.ts`, `providers/images/` | Separate unified API surface for text-to-image / image-generation providers/models. | None. |
| Custom/OpenAI-compatible provider support | `ai/src/compat.ts`, README "Custom Providers" section | `createProvider()` for arbitrary OpenAI-, Anthropic-, or Google-compatible APIs (Ollama, vLLM, LM Studio, etc.). | None. |
| Faux provider for testing | referenced in README ("Faux Provider for Tests") | Deterministic fake provider used by coding-agent's test harness (`test/suite/harness.ts` per AGENTS.md) to avoid real API calls. | None. |
| Context serialization / cross-provider handoff | README sections "Cross-Provider Handoffs", "Context Serialization" | Serializes conversation context so a session can hand off mid-conversation from one model/provider to another. | None. |
| Bedrock-specific entry point | `ai/bedrock-provider.ts` (root-level, separate export) | Dedicated Bedrock provider export, likely split out for bundle-size/runtime-dependency reasons (AWS SDK). | None. |
| Bun OAuth entry point | `ai/src/bun-oauth.ts` | Bun-runtime-specific OAuth flow implementation (separate from Node's). | Runtime-specific, not coding-specific. |

---

## packages/server (`theoses-server`)

Description (README): "Experimental... Server package for pi." Provides a transport-neutral session server core plus a Unix-socket transport; does not itself provide a coding-agent CLI or service — callers supply a `PiServerService`.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| `PiServer` session-server core | `server/src/server.ts`, `connection.ts`, `sessions.ts`, `protocol.ts` | Composes `PiServerListener` transports, manages session lifecycle (list/create/open/acquire) over the wire protocol, snapshot broadcasting. | None — deliberately generic; the caller's `PiServerService` supplies the actual session/storage backend. |
| Unix socket transport | `server/src/transports/unix/` | `createUnixListener()`/`createUnixServer()` presets using length-prefixed CBOR framing from `pi-protocol` over a Unix domain socket. | None coding-specific; assumes a Unix-like OS for the socket transport specifically (not for the protocol itself). |
| `pi-ai` ↔ `pi-protocol` bridge | `server/src/types.ts` (adapters referenced in README: `toProtocolModelMetadata`, `toProtocolAssistantMessage`, `toProtocolUserMessage`, `toProtocolToolResultMessage`) | Owns the boundary between `pi-ai` domain objects and `pi-protocol` wire DTOs; validates tool inputs/ids/timestamps and rejects mismatched tool results. | Tool-call/tool-result vocabulary mirrors coding-agent's tool model but is not filesystem/git specific itself. |
| Transport conformance testing kit | `server/src/testing/` | `createTestServer()`, `TestServerService`, `ProtocolTestClient`, `WireChannel` contract, `connectUnixTestClient()` for deterministic protocol tests against custom transports. | None. |
| Snapshot model | `server/src/snapshots.ts` | Defines authoritative session/server snapshot semantics (vs. transient progress events) shared with the protocol/client packages. | None. |

---

## packages/protocol (`theoses-protocol`)

Description (README): "Transport-neutral CBOR protocol for remote pi sessions." Pure wire-format package: schemas, CBOR codec, and byte-stream framing. No coding-specific concepts.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| CBOR encode/decode | `protocol/src/cbor/{encoder.ts, decoder.ts, index.ts, options.ts}` | Low-level CBOR codec used to serialize all protocol messages. | None. |
| Message schemas & validation | `protocol/src/schemas.ts`, `codec.ts` | Runtime schemas for client/server messages (`hello`, requests/responses, server events); `encodeClientMessage()`/`encodeServerMessage()` validate before encoding; throws `ProtocolValidationError` on schema/CBOR/framing violations. | Session/tool vocabulary (`SessionMetadata`, tool calls) again mirrors the coding-agent domain but is transport/schema-level only. |
| Byte-stream framing | `protocol/src/framing.ts` | Four-byte big-endian length prefix + one CBOR item per message; incremental decoders (`ClientMessageDecoder`/`ServerMessageDecoder`) handle arbitrary fragmentation/coalescing for streams/sockets. | None. |
| Protocol versioning | `protocol/src/index.ts` (`PROTOCOL_VERSION`) | First client message is always `hello` carrying the protocol version, enabling version negotiation/rejection. | None. |

---

## packages/client (`theoses-client`)

Description (README): "Transport-neutral client for remote pi sessions... The package has no Node-specific imports." Pure client-side session/connection state machine over `pi-protocol`.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| `PiClient` connection management | `client/src/client.ts`, `connection.ts`, `transport.ts` | Manages a `ByteTransportFactory`-supplied transport (WebSocket, Unix socket, etc.), correlates requests by ID, exposes `connect()`/`reconnect()` (no auto-reconnect). | None — transport-neutral by design, directly reusable for a non-terminal channel (e.g., Telegram bot backend talking to a pi session server). |
| Session leasing (exclusive/shared) | `client/src/session-handle.ts`, `state.ts` | `acquireSession()` returns an `AsyncDisposable` `SessionLease`; exclusive vs shared acquisition modes with `PiSessionOwnershipError` on conflicting acquisition; `attachSession()` convenience for shared mode. | None. |
| Snapshot/event subscription | `client/src/client.ts`, `promise.ts` | `subscribe()` for authoritative snapshots, `onEvent()` for transient protocol events; snapshots are the source of truth, progress events are not reduced into state. | None. |
| Error taxonomy | `client/src/errors.ts` | Structured client-side errors: `PiServerError`, `PiDisconnectedError`, `PiSessionDetachedError`, `PiSessionOwnershipError`. | None. |
| Unix transport convenience | `client/src/unix.ts` | Pre-built `ByteTransportFactory` for connecting over a Unix domain socket (pairs with `pi-server`'s Unix listener). | OS-specific (Unix sockets), not coding-specific. |

---

## packages/telemetry (`theoses-telemetry`)

Description (README): "Vendor-neutral telemetry contracts and typed schema utilities for pi packages... no exporter, global current-span state, or dependency on a telemetry backend." Fully generic observability layer.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| `TelemetryContext`/`TelemetrySpan` contract | `telemetry/src/index.ts` | Explicit, callback-based span/context interfaces that packages call into; apps supply an adapter (OpenTelemetry, Sentry, logs, etc.). | None. |
| No-op and in-memory reference implementations | `telemetry/src/noop.ts`, `memory.ts` | `NOOP_TELEMETRY_CONTEXT` for disabling telemetry cheaply; `InMemoryTelemetryContext` reference adapter for tests/local inspection. | None. |
| Typed schema definitions | `telemetry/src/index.ts` (schema exports referenced in README: start/completion attribute schemas) | Serializable schema definitions with inferred TypeScript types for domain-specific telemetry events (e.g., agent turns, tool calls) defined by consuming packages. | None itself; consumers (agent-core) define coding/agent-specific schemas on top. |
| Adapter conformance test kit | `telemetry/src/testing/{conformance.ts, index.ts, types.ts}` | Shared test suite any telemetry adapter implementation can run against to verify contract compliance. | None. |

---

## packages/evals (`theoses-evals`, private)

Description (package.json/README): "Behavioral, model-backed checks for Pi workflows... adapt a real `AgentSession` to `vitest-evals`." Internal, not published; used to evaluate the coding agent's behavior against real models.

| Capability | Location | Description | Coding-specific coupling |
|---|---|---|---|
| Pi coding-agent eval harness | `evals/src/pi-harness.ts` | `createPiCodingAgentHarness()` adapts a real `AgentSession` (from `pi-coding-agent`) to the `vitest-evals` `harness` contract, running in isolated temp project/agent directories and attaching native session JSONL artifacts. | Directly instantiates a full coding-agent session (tools, filesystem sandbox dirs) for every eval run. |
| Example eval suites | `evals/src/{smoke.eval.ts, extensions.eval.ts}` | Smoke test (factual Q&A) and an extensions-loading/behavior eval, using `describeEval()` from `vitest-evals`. | `extensions.eval.ts` specifically exercises the coding-agent extension system. |
| Vitest-evals integration utilities | `evals/src/vitest-evals/{artifacts.ts, harness-table.ts, reporter.ts, setup.ts, summary.ts}` | Custom reporter, run-artifact capture (`.eval/runs.jsonl`, session JSONL under `.eval/sessions/`), and summary output for eval runs. | Artifact format is native Pi session JSONL — coupled to the coding-agent session format. |
| Eval CLI runner | `evals/scripts/run-evals.mjs` (referenced by `npm run eval`) | Wires `--provider`/`--model` CLI args (or `THEOSES_PROVIDER`/`THEOSES_MODEL` env vars) through Pi's normal `ModelRuntime` auth (subscription credentials or API keys) into the eval run. | None beyond reusing coding-agent's auth/model resolution. |

---

## Cross-cutting observations (factual, not prescriptive)

- **Filesystem/project-directory coupling** recurs independently in several packages: `agent`'s skill loader and JSONL session backend, `coding-agent`'s session-cwd validation, project trust, resource loader (AGENTS.md walk-up), and package manager all model "a project" as a directory on local disk.
- **Git coupling** is narrower than filesystem coupling: it appears explicitly in `coding-agent/src/utils/git.ts` (parsing git URLs for package installs) and `coding-agent/src/core/footer-data-provider.ts` (reading `.git/HEAD` for branch display in the status footer). No other package reads git state directly.
- **Terminal/TUI coupling** is isolated almost entirely to `packages/tui` and `coding-agent/src/modes/interactive/`; the RPC mode, JSON mode, print mode, SDK (`createAgentSession`), and the `protocol`/`client`/`server` packages are transport- and UI-neutral by construction, and are the parts of the stack already shaped for a non-terminal channel (e.g., Telegram or a dashboard WebUI).
- **Coding-specific tools** (`bash`, `edit`/`edit-diff`, `read`, `write`, `find`, `grep`, `ls`) exist at two layers: a minimal default set in `agent/src/harness/tools/` and an extended set in `coding-agent/src/core/tools/`. Both are opt-in via the `AgentTool[]` array on agent state, not hardwired into the agent loop itself.
