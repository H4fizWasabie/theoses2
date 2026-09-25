# Theo Bible

Evidence-backed orientation for the Theoses2 repository at revision `e66120ddf` (`e66120ddf091eddecfeb1abe6066d7f4aff084ad`, 2026-09-14).

## Reading rule

Project context guides the investigation but is not authoritative. The current executable source code determines implemented behavior. When context, handoff notes, comments, READMEs, tests, and implementation disagree, document the disagreement and prefer the source path that actually runs. Each substantive statement in this folder points to a repository-relative file, symbol, and line range. Labels mean:

- **Verified**: directly read in the current source tree.
- **Probable**: supported by nearby code or package documentation, but not traced to every caller.
- **Intended**: stated in a README, ADR, or type contract; implementation confirmation is still required.
- **Legacy**: historical or compatibility behavior, not the preferred current path.
- **Unknown**: the current evidence is insufficient.

To locate code, files, tests, or config, use graft (`graft ask "<task>" --source`, `graft skeleton <file>`, `graft callers <symbol>`); it rebuilds from the working tree, so it cannot drift. This Bible covers architecture, intent, and decisions.

## Agent navigation index

Start with this file, choose the smallest route that matches the task, then open the cited source paths. Current executable source determines implemented behavior.

| If you need to understand... | Start here | Then follow |
|---|---|---|
| The system in five minutes | [01 Executive overview](01-executive-overview.md) | [03 Architecture](03-architecture.md), `graft map` |
| A user-facing feature | [04 Features](04-features.md) | [05 Runtime flows](05-runtime-flows.md), `graft ask` |
| What happens during a prompt | [05 Runtime flows](05-runtime-flows.md) | [03 Architecture](03-architecture.md), [06 Data model](06-data-model.md), relevant source links |
| Sessions, memory, compaction, or persistence | [06 Data model](06-data-model.md) | [04 Features](04-features.md), [08 Cross-cutting mechanisms](08-cross-cutting-mechanisms.md) |
| Public APIs or package boundaries | [07 Interfaces](07-interfaces.md) | `graft skeleton <file>`, `graft callers <symbol>` |
| Settings, environment variables, or resource loading | [08 Cross-cutting mechanisms](08-cross-cutting-mechanisms.md) | `graft grep "<setting or env var>"` |
| AI providers, models, auth, or streaming | [19 AI and provider architecture](19-ai-provider-architecture.md) | [07 Interfaces](07-interfaces.md), provider source/tests |
| Dashboard, Telegram, RPC, client, or server integration | [07 Interfaces](07-interfaces.md) | [05 Runtime flows](05-runtime-flows.md), [09 Operations](09-operations.md), adapter source/tests |
| Tests and what they exercise | [10 Testing](10-testing.md) | `graft grep "<symbol>"` scoped to `test/`, owning source and test file |
| Risks, uncertainty, or unresolved design questions | [11 Risk register](11-risk-register.md) | [15 Open questions](15-open-questions.md), cited source paths |
| Operations, release, CI, or deployment seams | [09 Operations](09-operations.md) | [10 Testing](10-testing.md) |
| TypeScript-to-Go rewrite planning or feature parity | [20 Go rewrite parity plan](20-go-rewrite-parity-plan.md) | [03 Architecture](03-architecture.md), [06 Data model](06-data-model.md), [07 Interfaces](07-interfaces.md) |
| How to continue or refresh this documentation | [18 Continuation note](18-continuation.md) | changed source paths |

## Contents

1. [Executive overview](01-executive-overview.md)
3. [Architecture](03-architecture.md)
4. [Features](04-features.md)
5. [Runtime flows](05-runtime-flows.md)
6. [Data model](06-data-model.md)
7. [Interfaces](07-interfaces.md)
8. [Cross-cutting mechanisms](08-cross-cutting-mechanisms.md)
9. [Operations](09-operations.md)
10. [Testing](10-testing.md)
11. [Risk register](11-risk-register.md)
12. [Glossary](12-glossary.md)
15. [Open questions](15-open-questions.md)
18. [Continuation note](18-continuation.md)
19. [AI and provider architecture](19-ai-provider-architecture.md)
20. [TypeScript-to-Go rewrite parity plan](20-go-rewrite-parity-plan.md)

## Refresh provenance

Graph navigation was refreshed on 2026-09-14 with `rtk graphify update .` and `rtk codegraph sync .`. The resulting CodeGraph status reported 1,130 files, 18,094 nodes, 77,069 edges, and an up-to-date 94.23 MB database. Graphify rebuilt 14,984 nodes, 30,692 edges, and 1,019 communities, with one extraction warning about a missing edge confidence field. Graph indexes are navigation aids only; they do not replace source verification.

## Safety boundary

No secrets or credential values belong in this folder. Environment-variable names may be documented; values must not be copied from local files or process state.
