# TypeScript-to-Go rewrite parity plan

## Status

This is a planning and reference document only. It does not authorize a rewrite, a parallel implementation, a deployment, or a cutover. The current TypeScript source remains the behavioral oracle until a replacement is explicitly approved.

The Bible describes architecture and intent. It does not prove behavioral parity: generated model catalogs, live provider behavior, terminal/browser behavior, Telegram delivery, deployment behavior, and every test execution still require separate evidence ([10 Testing](10-testing.md)).

## Recommendation

Do not begin with a full rewrite. First prove one vertical slice in Go: durable session state, the agent turn loop, one provider, the required tools, and one real channel. Keep TypeScript running as the oracle and compare observable behavior. A narrower Go seam is justified only by a concrete reliability, deployment, memory, or platform requirement; language preference alone is not enough.

The likely long-term shape is hybrid unless the parity gates prove otherwise:

```text
Go candidate core: session state -> agent loop -> tools/provider boundary
                         │
                 one validated channel

TypeScript retained initially: dashboard/browser UI, existing extensions,
                               unported providers, and operational fallback
```

The dashboard, RPC, Telegram, protocol, client, and server surfaces are distinct adapters and contracts, not automatic proof that one replacement runtime can serve them identically ([03 Architecture](03-architecture.md), [07 Interfaces](07-interfaces.md)).

## What “feature parity” means

Parity is behavioral, not line-for-line and not package-for-package. Every migrated capability must be checked across these dimensions:

| Dimension | Required question |
|---|---|
| Functional | Does the same user action produce the same meaningful result? |
| State/data | Are sessions, branches, artifacts, memory, checkpoints, and migrations readable and writable compatibly? |
| Temporal | Are ordering, streaming, cancellation, retries, queueing, and shutdown equivalent? |
| Error | Do malformed model output, provider errors, tool failures, auth failures, and partial writes fail safely? |
| Interface | Are CLI, SDK, channel, protocol, JSONL, and wire contracts compatible where compatibility is required? |
| Security | Are owner checks, bearer authentication, trust gates, path protections, and secret handling preserved? |
| Operations | Can it start, update, observe, roll back, and recover on the VPS? |
| Cost/performance | Is the behavior acceptable under representative LLM, tool, memory, and concurrent-session load? |
| User experience | Do the chosen channel’s visible messages, progress, attachments, and interruptions remain correct? |

The parity ledger must mark every difference as `accepted`, `blocked`, `deferred`, or `unknown`. “Works in a happy-path demo” is not a parity result.

## Milestones and phases

The phases are ordered. A phase may have implementation work only after its entry gate is met and its exit evidence is recorded.

| Milestone | Phase | Purpose | Exit gate |
|---|---|---|---|
| M0 | Baseline and decision | Freeze the TypeScript oracle, choose the concrete reason for Go, select the target channel and scope, and create the parity ledger. | Approved scope, baseline commit, target behavior list, and explicit non-goals. |
| M1 | Contract extraction | Convert the current runtime seams into language-neutral contracts and fixtures. | Types, serialized examples, event ordering, error semantics, and ownership boundaries are documented and reviewed. |
| M2 | Session and durable state | Reproduce session headers, JSONL entries, branching, resume/open/create, artifacts, working notes, and migrations. | Go can replay representative existing sessions and preserve required state without data loss. |
| M3 | Agent execution core | Reproduce prompt/continue/abort, queues, steering/follow-up, streaming events, tool calls, and lifecycle settlement. | Fake-provider traces match TypeScript for success, abort, retry, tool failure, and concurrent-input cases. |
| M4 | Provider boundary | Implement the provider-neutral request/stream/usage/retry boundary, then one provider end to end. | One provider passes deterministic contract tests and a credentialed live smoke test with matching failure semantics. |
| M5 | Tools, resources, and trust | Port only the tools and resource-loading paths required by the chosen slice; preserve trust and path-safety behavior. | Chosen tools, settings, skills/resources, and trust decisions match the oracle; unported extensions are explicit. |
| M6 | Memory and compaction | Port active context, compaction, semantic memory, episodic storage, task boundaries, consolidation checkpoints, and malformed-output recovery as required by scope. | Fixture replay and failure injection prove checkpoint safety, retry/cooldown behavior, and no silent data loss. |
| M7 | Primary channel pilot | Run the Go slice beside TypeScript for one real channel in shadow or opt-in mode. | Live acceptance traces match, rollback is tested, and no unresolved P0/P1 discrepancy remains. |
| M8 | Secondary adapters | Port additional CLI, Telegram, dashboard, RPC, client/server, or protocol surfaces only when their value is demonstrated. | Each adapter has its own contract, live check, ownership model, and rollback path. |
| M9 | Operations and release | Reproduce configuration, systemd lifecycle, updater behavior, observability, backups, migrations, and release rollback. | A fresh VPS rollout and rollback succeed from documented commands without manual hidden steps. |
| M10 | Parity signoff and cutover | Decide whether Go replaces, shares, or remains behind TypeScript. | Signed parity report, accepted-difference list, rollback window, and explicit decommission decision. |

### Phase 0: baseline and decision details

Before writing Go, record:

- TypeScript source revision and deployed revision, separately. The deployed release is not assumed to be the local checkout.
- The one concrete problem Go must solve. Examples: a measured memory ceiling, deployment constraint, platform requirement, or reliability defect.
- The primary user journey and channel. Do not promise parity for every surface before one path is proven.
- The compatibility policy: read old sessions, write new sessions, preserve wire protocol, or intentionally break compatibility.
- The features explicitly deferred. Deferred is safer than accidental partial parity.

If the concrete problem cannot be stated or measured, stop at M0.

### Phase 1: contract extraction details

Start from the strongest seams already present:

- `packages/agent/src/agent.ts` and `agent-loop.ts`: low-level turn lifecycle, queues, tool execution, abort, and provider streaming.
- `packages/coding-agent/src/core/agent-session.ts`: product-facing session state machine.
- `packages/coding-agent/src/core/session-manager.ts`: JSONL persistence, tree navigation, branching, artifacts, and migration.
- `packages/coding-agent/src/core/sdk.ts` and `agent-session-services.ts`: construction and dependency ownership.
- `packages/protocol/src/schemas.ts`, `codec.ts`, `packages/client`, and `packages/server`: only if the remote boundary is in scope.

For each contract, capture inputs, outputs, ordering, cancellation, persistence effects, error behavior, and test evidence. Do not infer a contract from a README when the implementation or callers disagree.

### Phase 2-6 implementation order

The recommended dependency order is:

```text
session/state -> agent loop -> one provider -> required tools
                                      ├-> memory/compaction
                                      └-> primary channel
```

Provider breadth, extension compatibility, dashboard parity, and remote protocol parity come later. The existing provider catalog and extension surface are large enough to become a rewrite by themselves; they must not silently enter scope.

## Parity ledger template

Create one row per user-visible behavior or durable contract, not one row per Go file:

| ID | Capability | TypeScript authority | Test/trace | Go status | Difference | Decision |
|---|---|---|---|---|---|---|
| P-001 | Session resume | source path, symbol, lines | fixture/test ID | pending | none known | pending |
| P-002 | Prompt stream and tool result ordering | source path, symbol, lines | golden trace | pending | none known | pending |
| P-003 | Provider retry and abort | source path, symbol, lines | deterministic test/live smoke | pending | none known | pending |
| P-004 | Memory checkpoint after malformed JSON | source path, symbol, lines | injected failure trace | pending | none known | pending |
| P-005 | Primary channel delivery | adapter path, handler | live acceptance trace | pending | none known | pending |

The ledger must link to the current TypeScript implementation, not only to this Bible. When source changes, re-read the changed path and update the ledger before changing the Go behavior.

## Verification strategy

Use progressively stronger evidence:

1. **Static contract evidence:** source, callers, schemas, and dependency effects.
2. **Deterministic tests:** fake providers, fixed session fixtures, event traces, failure injection, and migration tests.
3. **Golden traces:** identical prompts and tool inputs against both runtimes; compare normalized events, durable writes, visible replies, and error classes.
4. **Shadow or dual-run pilot:** TypeScript remains authoritative while Go observes or handles an opt-in path.
5. **Live acceptance:** real provider, real channel, real VPS process, restart, update, rollback, and recovery checks.

Do not compare only final text. Compare event order, tool arguments, tool results, usage accounting, checkpoint movement, session files, attachments, cancellation, and logs. Do not treat test enumeration or Bible coverage as test passage.

## Risks and stop conditions

| Risk | Stop condition |
|---|---|
| Scope expansion from “rewrite” to every provider, extension, adapter, and UI | Return to the selected vertical slice and record the rest as deferred. |
| Data incompatibility in JSONL, memory, artifacts, or migrations | No cutover until old data is replayed and rollback preserves it. |
| Event-order or cancellation drift | Block channel rollout until golden traces match. |
| Provider-specific behavior hidden behind the common API | Add provider-specific contract tests; do not claim generic parity. |
| TypeScript extension ecosystem cannot run in Go | Keep TypeScript extension execution or define a deliberate replacement boundary. |
| Go does not solve a measured problem | Stop the rewrite and keep improving the TypeScript runtime. |
| Live deployment differs from local source | Treat the deployed revision and configuration as a separate oracle; certify both. |
| Performance claim is based on idle sampling or language preference | Require representative workload measurements before making the claim. |

## Agent instructions for future rewrite work

1. Read this plan and the relevant Bible route before proposing implementation.
2. Refresh Graphify and CodeGraph after source changes; use them for navigation, not as behavioral authority.
3. Verify every claimed TypeScript behavior against current source and callers.
4. Update the parity ledger, open questions, and continuation note after each accepted milestone.
5. Keep TypeScript operational until M10 signoff; never make an irreversible cutover during a parity experiment.
6. Report `verified`, `probable`, `intended`, `legacy`, and `unknown` separately.

## Current decision

No rewrite is approved by this document. The next valid action is M0: define the concrete reason, primary journey, compatibility policy, and first vertical slice. Until that decision is made, changes should remain discussion, measurement, or parity-fixture work.
