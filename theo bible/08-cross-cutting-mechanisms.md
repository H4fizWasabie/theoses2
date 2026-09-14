# Cross-cutting mechanisms

## Settings and trust

`SettingsManager` deep-merges global and project settings, migrates older setting shapes, and refuses project writes when the project is untrusted. Writes are queued, lock-protected, and merge only the fields changed by this manager against current file contents; parse/write failures remain drainable diagnostics ([packages/coding-agent/src/core/settings-manager.ts](../packages/coding-agent/src/core/settings-manager.ts), `SettingsManager`/`FileSettingsStorage`, lines 208-690). The trust manager detects trust-requiring `.theoses` resources and ancestor `.agents/skills`, resolves the nearest normalized ancestor decision, and persists decisions in a locked `trust.json`; user-global `~/.agents/skills` is excluded from the project gate ([packages/coding-agent/src/core/trust-manager.ts](../packages/coding-agent/src/core/trust-manager.ts), `hasTrustRequiringProjectResources`/`ProjectTrustStore`, lines 30-245). The CLI resolves project trust before loading project resources when trust-requiring resources exist ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 693-769).

## Resource loading

Extensions, skills, prompt templates, themes, context files, system-prompt overrides, and inline extension factories are passed to the resource loader. Load failures become diagnostics and can terminate non-interactive startup ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 702-831 and 885-896).

`DefaultResourceLoader` collects user/project resources, applies trust and disabled-resource rules, loads global and ancestor context-file candidates, and supports `noContextFiles` plus an override hook. The session reads the resulting `agentsFiles` and passes their contents into system-prompt construction; this is runtime input, not an authority mechanism. If those files conflict with executable behavior, the source path that runs is the evidence to prefer ([packages/coding-agent/src/core/resource-loader.ts](../packages/coding-agent/src/core/resource-loader.ts), context discovery and reload, lines 87-108, 145-190, 211-258, and 476-645; [packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), prompt preparation, lines 1119-1124; [packages/coding-agent/src/core/system-prompt.ts](../packages/coding-agent/src/core/system-prompt.ts), context-file rendering, lines 67-121 and 221-228).

## Context limits and compaction

The system has separate active-context limiting, compaction, reply-context, Working Note, transcript, and protocol-frame ceilings. These limits are not interchangeable: active context controls the model projection, reply context enriches a new prompt, and frame limits protect the wire boundary ([packages/coding-agent/src/core/session-manager.ts](../packages/coding-agent/src/core/session-manager.ts), lines 31-41 and 437-545; [packages/protocol/src/framing.ts](../packages/protocol/src/framing.ts), lines 1-61).

## Retry and abort

The settings contract includes agent/provider retry controls. `AgentSession.abort` aborts retry and agent activity and waits for idle; Telegram maps this to an owner-visible stop path ([packages/coding-agent/src/core/agent-session.ts](../packages/coding-agent/src/core/agent-session.ts), `abort`, lines 1636-1650; [packages/telegram/src/index.ts](../packages/telegram/src/index.ts), stop handling, lines 423-474).

## Concurrency

The CLI agent owns prompt/steer/follow-up queues. Dashboard serializes chat work per session. Telegram serializes updates per chat while allowing grammY to dispatch stop messages. The remote server uses singleflight session acquisition and operation counts; conflicting runtime operations are expected to reject rather than queue ([packages/server/src/types.ts](../packages/server/src/types.ts), lines 20-40; [packages/server/src/sessions.ts](../packages/server/src/sessions.ts), lines 176-252; [packages/dashboard/src/index.ts](../packages/dashboard/src/index.ts), lines 334-404; [packages/telegram/src/index.ts](../packages/telegram/src/index.ts), lines 489-763).

## Observability

Telemetry is explicit and vendor-neutral: packages receive a context and adapters own backend/exporter behavior. The package intentionally has no global current span or exporter ([packages/telemetry/README.md](../packages/telemetry/README.md), opening sections). Runtime diagnostics are collected from settings, services, model/resource loading, and trust resolution ([packages/coding-agent/src/main.ts](../packages/coding-agent/src/main.ts), lines 771-797).

## Output adaptation

Terminal, dashboard SSE, and Telegram each translate common session events into their presentation format. Telegram additionally converts Markdown-like content to HTML/rich-message fallbacks and chunks messages to platform limits ([packages/telegram/src/format.ts](../packages/telegram/src/format.ts), `splitSections`/`formatTelegramHtml`, lines 34-51 and 140-194).
