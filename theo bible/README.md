# Theo Bible

Evidence-backed orientation for the Theoses2 repository at revision `e66120ddf` (`e66120ddf091eddecfeb1abe6066d7f4aff084ad`, 2026-09-14).

## Reading rule

Project context guides the investigation but is not authoritative. The current executable source code determines implemented behavior. When context, handoff notes, comments, READMEs, tests, and implementation disagree, document the disagreement and prefer the source path that actually runs. Each substantive statement in this folder points to a repository-relative file, symbol, and line range. Labels mean:

- **Verified**: directly read in the current source tree.
- **Probable**: supported by nearby code or package documentation, but not traced to every caller.
- **Intended**: stated in a README, ADR, or type contract; implementation confirmation is still required.
- **Legacy**: historical or compatibility behavior, not the preferred current path.
- **Unknown**: the current evidence is insufficient.

This pass is complete for the current tracked revision: every in-scope path has been inspected, while exclusions are explicit and remain in the ledger. The measured completion gate is recorded in [14-coverage-ledger.md](14-coverage-ledger.md), with the path-by-path evidence ledger in [14-file-inventory.md](14-file-inventory.md).

## Contents

1. [Executive overview](01-executive-overview.md)
2. [Repository map](02-repository-map.md)
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
13. [Source index](13-source-index.md)
14. [Coverage ledger](14-coverage-ledger.md)
15. [Open questions](15-open-questions.md)
16. [Configuration index](16-configuration-index.md)
17. [Test and fixture index](17-test-index.md)
18. [Continuation note](18-continuation.md)
19. [AI and provider architecture](19-ai-provider-architecture.md)

## Refresh provenance

Graph navigation was refreshed on 2026-09-14 with `rtk graphify update .` and `rtk codegraph sync .`. The resulting CodeGraph status reported 1,130 files, 18,094 nodes, 77,069 edges, and an up-to-date 94.23 MB database. Graphify rebuilt 14,984 nodes, 30,692 edges, and 1,019 communities, with one extraction warning about a missing edge confidence field. Graph indexes are navigation aids only; they do not replace source verification.

## Safety boundary

No secrets or credential values belong in this folder. Environment-variable names may be documented; values must not be copied from local files or process state.
