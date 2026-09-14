# Risk register

| Risk | Evidence | Impact | Status / next check |
|---|---|---|---|
| Bible coverage can be mistaken for exhaustive | 1,344 tracked files are enumerated; 1,282 in-scope rows are source-read and 62 exclusions are explicit | False confidence during maintenance | **Controlled for revision `e66120ddf`**: recompute after tracked-path changes |
| Graph report can drift from source | Graphify and CodeGraph are refreshed for the current revision, but graph output is navigation metadata rather than behavioral authority | Navigation may become stale after later source changes | **Controlled for this revision**: rerun Graphify/CodeGraph after source changes |
| Experimental remote API drift | Protocol/server docs state experimental/no compatibility guarantee | Clients can break across revisions | **Open**: add explicit compatibility/version policy before external consumers |
| Server has no first-party coding-agent service binding | `TheosesServerService` is injected and server README says no standalone coding-agent service | Remote package cannot run the product alone | **Unknown**: determine whether this is intentional deferral |
| Project resource execution requires trust discipline | CLI resolves project trust before resource loading and can surface extension failures | Untrusted project content may affect execution if trust policy regresses | **Mitigated in current path**; add end-to-end trust tests |
| File delete is recursive | Dashboard `deletePath` accepts directories | Operator can remove a directory tree | **Verified**: preserve confirmation/auth controls and add destructive-route tests |
| Memory recall is lexical | `remember` uses term matching and bounded graph traversal, not semantic embeddings | Synonyms and paraphrases may be missed | **Intentional current design**; add only if observed recall failure justifies it |
| SQLite runtime availability | Episodic store imports `node:sqlite` dynamically | Bun/older Node deployment can fail when episodic memory is used | **Open**: document supported runtime and startup failure behavior |
| Telegram session orphaning across release dirs | Session cwd defaults to process cwd unless stable override is set | Working Note and active context appear lost after deploy | **Mitigated**: require stable `THEOSES_TELEGRAM_CWD` in deployment |
| Unbounded/large surfaces remain | AI provider matrix, TUI, examples, and 500 tests are inventoried and source-read; generated model artifacts have explicit generator/exclusion treatment | Hidden coupling may be missed | **Controlled for revision `e66120ddf`**: maintain source-index/ledger evidence |
| Provider-specific AI behavior is unevenly evidenced | Core provider/auth/refresh dispatch, all 31 API adapter files, provider factories, and OAuth modules are source-traced, but focused tests, catalog-refresh policies, and production usage remain unreconciled | Model-specific request, auth, retry, or compatibility failures may be undocumented | **Open**: reconcile source behavior with focused tests and runtime usage |
| Legacy AI compatibility path remains reachable | `theoses-ai/compat` exports deprecated global APIs and a mutable API registry | Old consumers or extensions may bypass newer provider/auth guarantees | **Open**: search all consumers and decide retirement boundary |

## Priority interpretation

The first three follow-up checks are: settle the remote-service ownership question, verify runtime/deployment constraints around `node:sqlite` and stable Telegram cwd, and certify dashboard/TUI/Telegram behavior in their real environments. These are product or operational questions, not claims that the current tracked source was left unread.
