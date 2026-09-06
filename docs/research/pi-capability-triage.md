# Pi Capability Triage

Historical note: this filename preserves the original research subject; the triage classifies the upstream Pi architecture that Theoses was forked from.

Batch triage of the inventory in `docs/research/pi-capability-inventory.md` (GitHub issue
[#6](https://github.com/H4fizWasabie/theoses2/issues/6)), applying the decision process from
issue [#5](https://github.com/H4fizWasabie/theoses2/issues/5), for GitHub issue
[#7](https://github.com/H4fizWasabie/theoses2/issues/7), a child of the Theoses2 engine map
(issue [#1](https://github.com/H4fizWasabie/theoses2/issues/1)).

Verdicts: **keep** (as-is), **refactor** (adapt, survives with changes), **cut** (no
personal-assistant use case even adapted), **discuss** (doesn't cleanly resolve under the
criteria — needs its own grilling ticket).

---

## packages/agent

| Capability | Verdict | Rationale |
|---|---|---|
| Core agent loop | keep | Model/tool/message-agnostic; the engine's foundation regardless of channel. |
| Steering & follow-up message queues | keep | Directly useful for a long-lived assistant handling interleaved input. |
| Tool execution hooks | keep | Channel-neutral extension point. |
| Custom message types via declaration merging | keep | Extension mechanism for channel-specific message roles (Telegram, dashboard). |
| Agent harness (system prompt, prompt templates, result types) | refactor | Default system prompt implies a coding-assistant persona; needs a personal-assistant prompt, harness structure otherwise reusable. |
| Session tree/log storage abstraction | keep | Already the reuse target for the Working Note per issue #3's resolution. |
| Session search | keep | Useful for a personal assistant recalling past conversations. |
| Context compaction / summarization | keep | Resolved in issue #12 (was refactor in this pass): on inspection, `extractFileOperations()` already degrades gracefully for non-file turns (empty lists, no-op footer) and the underlying LLM summary is already tool-agnostic — no code change needed. |
| Skills loading | keep | Generic directory-based skill loading, not coding-specific in concept. |
| Default coding tools (bash/read/write/edit/edit-diff, image) | keep | Explicitly preserved per the map's Notes ("preserve Pi's coding-agent capabilities"). |
| Node execution environment adapter | keep | Required to run any tool. |
| Output truncation & shell-output capture utilities | keep | Needed wherever bash/tool output flows to an LLM context. |
| Telemetry instrumentation hooks | keep | Channel-neutral observability. |
| LLM streaming proxy | keep | Needed once a web UI wraps the engine (per the map's Destination). |

## packages/coding-agent

| Capability | Verdict | Rationale |
|---|---|---|
| CLI entry & argument parsing | keep | CLI is a first-class channel per the map's Notes. |
| Four run modes (interactive/print/JSON/RPC) | keep | Interactive serves the CLI channel; JSON/print/RPC are already transport-neutral and reusable for other channels. |
| Agent session runtime | keep | The SDK entry point (`createAgentSession`) the engine builds on. |
| Default coding tools (extended: find/grep/ls/powershell) | keep | Preserved coding-agent capability per the map's Notes. |
| Session management & storage | refactor | `session-cwd.ts` errors when a session's stored cwd no longer exists — a named incompatibility, since Telegram/dashboard sessions have no project directory (per issues #2/#3, sessions are per-channel, not per-cwd). |
| Session branching / tree navigation | keep | Branching model and `/tree` stay for the CLI channel. |
| Context compaction (product layer) | keep | Wraps agent-core compaction with product-level triggers; no incompatibility identified. |
| Extension system | refactor | Resolved in issue #14: narrowed rather than decoupled — kept only for CLI-specific terminal UI customization (components/keybindings/themes); tool/command extensibility across channels moves to Mino's HTTP sidecar protocol and MCP instead, both adopted as new tool sources. |
| Package manager (pi packages) | cut | No personal-assistant use case for installing/updating third-party npm/git bundles of extensions/skills/prompts/themes, even adapted — this is a distribution feature for a shared product, not a personal engine. |
| Project trust | keep | Resolved in issue #15 (was refactor in this pass): doesn't gate tool execution at all, only project-local settings/extensions/package loading; non-CLI channels simply never invoke it (no cwd to check), CLI behavior is unchanged. |
| Skills (product layer) | keep | Built on the agent-core loader; no incompatibility. |
| Prompt templates | keep | Filesystem-based but not coding-specific in concept. |
| Model runtime, resolver, registry, config | keep | Generic LLM provider/model management, no coding coupling. |
| Auth & credential storage | keep | No coding coupling. |
| Settings & keybindings | keep | Core config plumbing needed regardless of channel; keybindings serve the CLI channel specifically. |
| Context files (AGENTS.md/CLAUDE.md loading) | keep | Coding-agent-specific capability explicitly preserved per the map's Notes. |
| Git integration | refactor | Footer branch-display (`.git/HEAD` read) stays useful for the CLI's coding mode; the git-URL-parsing half exists only to serve the package manager, which is cut, so it goes with it. |
| Bash/PowerShell execution & shell utilities | keep | Coding-agent capability explicitly preserved. |
| HTML session export | keep | Channel-neutral export/sharing format, no incompatibility. |
| Session sharing (GitHub gist `/share`) | cut | Hard dependency on GitHub as the sharing target with no personal-assistant use case; HTML export already covers sharing needs. |
| RPC client/server protocol | keep | Transport-neutral, reusable for driving the engine from a dashboard or other channel process. |
| Local session server bootstrap | keep | Feeds the server package's session model. |
| Image handling (paste/clipboard/resize) | refactor | Terminal-clipboard/drag-drop capture is CLI-specific, but the inventory itself notes this is relevant to a chat-style assistant's image attachments (Telegram) with adaptation. Resolved in issue #9: channel-neutral `images: string[]` core contract (as in Mino's `RespondFor`), CLI keeps its existing capture, Telegram gets a new Mino-style download/base64 capture, dashboard capture deferred as fog. |
| llama.cpp router integration | keep | Resolved in issue #8 (was discuss in this pass) — kept as-is, no refactor needed. |
| Windows self-update / version checks | cut | Distribution-and-self-update model for a shared CLI product; a personal, self-owned engine has no equivalent use case. |
| Autocomplete / file reference in editor | keep | Serves the CLI's coding-agent mode, which is preserved. |

## packages/tui

| Capability | Verdict | Rationale |
|---|---|---|
| TUI renderers | keep | CLI is a first-class channel. |
| Differential rendering & synchronized output | keep | CLI-channel implementation detail. |
| Editor component | keep | CLI-channel implementation detail. |
| Built-in component library | keep | CLI-channel implementation detail. |
| Inline image rendering (Kitty/iTerm2) | keep | CLI-channel implementation detail. |
| Autocomplete framework | keep | Generic fuzzy-match interface, consumed by coding-agent's file/command completion. |
| Keybinding matching | keep | CLI-channel implementation detail. |
| Native modules (Windows/macOS) | keep | CLI-channel implementation detail. |
| Terminal abstraction | keep | CLI-channel implementation detail. |
| LaTeX rendering helper | keep | Used by the markdown component; no incompatibility. |

None of `packages/tui` is cut or refactored: it's entirely CLI-channel plumbing, and the CLI channel itself is in scope per the map's Notes, so the whole package stays as-is.

## packages/session-backends/sqlite-node

| Capability | Verdict | Rationale |
|---|---|---|
| SQLite session repository | keep | Channel-neutral; directly the storage backend the memory contract (issues #2/#3) can build on. |
| Schema migrations | keep | No incompatibility. |
| Branch materialization / caching | keep | No incompatibility. |
| Full-text search backend | keep | Useful for a personal assistant searching its own history. |
| `node:sqlite` adapter | keep | No incompatibility. |

## packages/ai

| Capability | Verdict | Rationale |
|---|---|---|
| Unified streaming/completion API | keep | Provider-layer, no coding coupling. |
| Provider registry & model catalog | keep | No coding coupling. |
| Auth resolution & credential store | keep | No coding coupling. |
| Provider implementations | keep | No coding coupling. |
| Image generation API | keep | No coding coupling; no reason to cut a capability that costs nothing to retain. |
| Custom/OpenAI-compatible provider support | keep | No coding coupling. |
| Faux provider for testing | keep | Needed for tests regardless of channel. |
| Context serialization / cross-provider handoff | keep | No coding coupling. |
| Bedrock-specific entry point | keep | No coding coupling. |
| Bun OAuth entry point | keep | No coding coupling. |

## packages/server

| Capability | Verdict | Rationale |
|---|---|---|
| `PiServer` session-server core | keep | Needed for the multi-channel, long-lived server model the map's Destination implies. |
| Unix socket transport | keep | No incompatibility. |
| `pi-ai` ↔ `pi-protocol` bridge | keep | No incompatibility. |
| Transport conformance testing kit | keep | No incompatibility. |
| Snapshot model | keep | No incompatibility. |

## packages/protocol

| Capability | Verdict | Rationale |
|---|---|---|
| CBOR encode/decode | keep | Needed for remote sessions (dashboard, other channels). |
| Message schemas & validation | keep | No incompatibility. |
| Byte-stream framing | keep | No incompatibility. |
| Protocol versioning | keep | No incompatibility. |

## packages/client

| Capability | Verdict | Rationale |
|---|---|---|
| `PiClient` connection management | keep | Inventory already notes this is directly reusable for a non-terminal channel. |
| Session leasing (exclusive/shared) | keep | No incompatibility. |
| Snapshot/event subscription | keep | No incompatibility. |
| Error taxonomy | keep | No incompatibility. |
| Unix transport convenience | keep | No incompatibility. |

## packages/telemetry

| Capability | Verdict | Rationale |
|---|---|---|
| `TelemetryContext`/`TelemetrySpan` contract | keep | Fully generic. |
| No-op and in-memory reference implementations | keep | Fully generic. |
| Typed schema definitions | keep | Fully generic. |
| Adapter conformance test kit | keep | Fully generic. |

## packages/evals

| Capability | Verdict | Rationale |
|---|---|---|
| Pi coding-agent eval harness | keep | Dev-tooling for the preserved coding-agent mode; orthogonal to the personal-assistant redesign. |
| Example eval suites | keep | Dev-tooling. |
| Vitest-evals integration utilities | keep | Dev-tooling. |
| Eval CLI runner | keep | Dev-tooling. |

---

## Summary

- **Cut**: package manager, session sharing (GitHub gist), Windows self-update/version checks.
- **Refactor**: agent harness (system prompt), context compaction (file-operation extraction),
  session management & storage (cwd coupling), extension system (TUI-type coupling), project
  trust (directory-only model), git integration (split: keep footer, cut package-install
  parsing), image handling (channel adaptation).
- **Discuss**: llama.cpp router integration — spun out as its own ticket.
- **Keep**: everything else — the large majority of the ~60 capabilities, concentrated in
  `packages/tui`, `packages/session-backends`, `packages/ai`, `packages/server`,
  `packages/protocol`, `packages/client`, `packages/telemetry`, `packages/evals`, and most of
  `packages/agent` and `packages/coding-agent`.
