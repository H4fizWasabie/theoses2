# Coverage ledger

## Completion gate

The requested completion formula is:

```text
fully inspected in-scope files / total in-scope files × 100
```

This pass passes that gate. Every in-scope tracked path has a `Fully inspected` row in the complete path-by-path appendix, [14-file-inventory.md](14-file-inventory.md). Generated, vendored, lockfile, and binary artifacts remain present in the ledger with explicit exclusions.

## Repository inventory

`git ls-files` reported 1,344 tracked files on revision `e66120ddf`. The appendix classifies 62 explicitly excluded artifacts, leaving 1,282 in-scope files.

| Inventory class | Count | Treatment in this pass |
|---|---:|---|
| Source | 609 | Every in-scope source row inspected and summarized; runtime claims remain source-authoritative |
| Tests/fixtures | 500 | Every in-scope test/fixture row inspected and summarized; not every test was run |
| Documentation/text | 92 | Root instructions, context, handoff, package READMEs, CI, and selected docs read |
| Configuration/resources | 71 | Every in-scope configuration/resource row inspected and summarized |
| Explicitly excluded artifacts | 62 | 7 lockfiles, 41 generated model artifacts, 4 vendored/build files, 10 binary/image assets/native addons; exact paths are in the appendix |
| Other | 10 | Every in-scope other row inspected; excluded binary-like rows are counted above |

## File-level status counts

From the path-by-path appendix: 1,282 fully inspected, 0 partially inspected, 0 not inspected, and 62 excluded. Therefore the inspection coverage is `1,282 / 1,282 × 100 = 100.00%` of in-scope files.

## Subsystem status

| Subsystem | Status | Evidence read | Remaining gap |
|---|---|---|---|
| CLI and mode dispatch | Fully inspected | `main.ts`, CLI/mode source, RPC/client paths, tests | Live command execution not exercised |
| SDK/runtime construction | Fully inspected | SDK/services/runtime/settings/model/session source and tests | Live provider/auth behavior remains environment-dependent |
| Agent loop | Fully inspected | agent package and coding-agent integration source/tests | Full suite execution intentionally not run |
| Session persistence | Fully inspected | session manager, migrations, compaction, export, branch/session tests | Live filesystem contention not exercised |
| Semantic/episodic memory | Fully inspected | stores, consolidation, task-boundary callers, backfill and tests | Model-backed consolidation is credential-gated |
| Tools/extensions/resources | Fully inspected | tools, resources, extensions, examples, skills/prompts/themes and tests | Opt-in/live extension behavior remains environment-dependent |
| AI providers/auth | Fully inspected | AI source/adapters/scripts/tests and provider architecture | Live authentication/provider matrix remains environment-dependent |
| Protocol | Fully inspected | protocol source/tests and coding-agent RPC callers | No network deployment certification performed |
| Server/client | Fully inspected | server/client source/tests/transports | No external service deployment certification performed |
| Dashboard | Fully inspected | server and browser assets/tests | No live browser session run in this pass |
| Telegram | Fully inspected | bot/format source/tests | No live Bot API call run in this pass |
| Telemetry | Fully inspected | implementation, testing contract, README/changelog, tests | No exporter is owned by this package |
| TUI | Fully inspected | README, renderer/input/component source/tests/native build resources | Real terminal matrix remains environment-dependent |
| CI/release/operations | Fully inspected | workflows, hooks, root scripts, updater units/scripts, prototypes | No release/deploy mutation was performed |

## Key files fully inspected for this baseline

The central evidence set is the full in-scope inventory, with subsystem summaries in [13-source-index.md](13-source-index.md), [04-features.md](04-features.md), [05-runtime-flows.md](05-runtime-flows.md), [06-data-model.md](06-data-model.md), [07-interfaces.md](07-interfaces.md), [08-cross-cutting-mechanisms.md](08-cross-cutting-mechanisms.md), and [19-ai-provider-architecture.md](19-ai-provider-architecture.md). Claims distinguish current implementation from intended/documentary guidance.

"Fully inspected" here means read sufficiently for the documented claim, with path/symbol/line evidence recorded where the claim is substantive. It does not mean every line is reproduced in the ledger. Tests are indexed and source-read, but the documentation does not claim that every test was executed.

## Continuation protocol

Future maintenance should take one subsystem at a time, re-read changed source, and update this ledger, [13-source-index.md](13-source-index.md), [15-open-questions.md](15-open-questions.md), and [18-continuation.md](18-continuation.md). Recompute the numerator and denominator whenever tracked paths or exclusions change.
