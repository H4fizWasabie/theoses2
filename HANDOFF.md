# Handoff — 2026-09-02 session

Resume by reading the **Theoses2 engine map**: [issue #1](https://github.com/H4fizWasabie/theoses2/issues/1) on this repo's GitHub tracker. It's the canonical, up-to-date index of every decision made and everything still open — this file is just a pointer plus context that isn't captured on the map itself (source paths, corrected assumptions, session narrative).

## State at handoff

Two tickets resolved and closed this session, both memory-related:

- [Promotion boundary: Pi learning material to durable semantic memory](https://github.com/H4fizWasabie/theoses2/issues/17) — `pi-self-learning` (installed npm extension) ruled out entirely; Theoses2 gets an explicit `save_note`-equivalent tool plus the automatic compaction-triggered distillation pass (issue #3) as a safety net, with explicit-saved turns flagged and excluded from the automatic pass to prevent duplicate facts; automatic pass's promotion bar transfers from Mino unchanged.
- [Working Note bound sizes and inspection command shape](https://github.com/H4fizWasabie/theoses2/issues/18) — write cap 4000 chars / injection cap 2000 chars (chars, not tokens — Pi's own `estimateTokens` is just chars/4, no real tokenizer, so switching units buys nothing); inspection command is new design with no Mino precedent (Mino never built human-facing exposure for `session_notes`) — one shared session-runtime query, read-only, surfaced identically across CLI/Telegram/dashboard as `working-note`, showing the full raw note not the injection-truncated view.

The map's frontier (issue #1 "Not yet specified") is now three items:

- Mechanical/tool-trail auto-capture into the Working Note (deferred as YAGNI in ticket #3 until a concrete recurrence justifies it — probably skip unless something forces it).
- The web UI's shape and how it wraps the engine — **gated** until the engine redesign is more settled; an existing separate "theoses" project's UI/UX is the intended source to copy from.
- The Pi-to-theoses branding rename's exact mechanics (which files/names change, when) — target name is settled ("theoses"), execution is not. Closer to a checklist than a debate; likely the fastest of the three to close.

Next session: pick one of those three, or ask what to sharpen. The rename is probably the easiest next pick since it's unblocked and low-ambiguity; the web UI item stays blocked until more of the engine redesign lands.

## Corrections made this session (don't repeat these mistakes)

- **`remember` (Mino) is retrieval-only, not storage.** Storage happens via a separate explicit `save_note` tool the model calls mid-conversation, plus a background `ConsolidateDue`/`ConsolidateIfFull` safety-net pass. I initially had this backwards — assumed `remember` was the write path. Corrected by the user, then verified directly against `tools.go:843-866` (remember) and `tools.go:1512-1530` (save_note).
- **`pi-self-learning` is a real, installed capability the original inventory missed** — it's a third-party npm extension (`~/.theoses/agent/npm/node_modules/pi-self-learning`), not part of `packages/*`, so the ~60-capability inventory (issue #6) never saw it. It provides `/learning-*` slash commands, git-backed markdown memory, task-completion-triggered mistake/fix reflection, and an always-injected `CORE.md`. Ruled out for Theoses2 (issue #17) — CLI-only per issue #14's `ExtensionAPI` scoping, wrong trigger granularity, wrong content shape (mistake-prevention, not general facts), and unbounded per-turn injection growth wrong for long-running sessions.
- **Pi's "tokens" are not real tokens.** `packages/agent/src/harness/compaction/compaction.ts`'s `estimateTokens` is `Math.ceil(chars / 4)` — no per-provider tokenizer. Relevant any time a future ticket is tempted to reach for "just use tokens for precision" — there's no precision to gain without adding a real tokenizer dependency first.
- **Mino doesn't solve everything it's used as a reference for.** Two confirmed gaps in Mino's own implementation, found by reading the actual source rather than trusting the general shape: (1) no deduplication between `save_note`-written facts and the automatic consolidation pass reprocessing the same turns — a live risk in Mino itself; (2) zero human-facing inspection for `session_notes` (no command anywhere, only direct SQLite access). Both times the fix was to design past the gap rather than port it. Worth re-checking Mino's actual behavior before assuming precedent exists, per the existing lesson in the prior handoff about verifying assumptions against source.

## Reference material (carried over + new this session)

- **Mino OSS source**: `~/Desktop/mino-oss` — the reference implementation throughout. New pulls this session: `memory.go` (session note cap/injection, consolidation/distillation prompts, open-loops extraction, community synthesis), `tools.go` (`remember`, `save_note`, `add_working_memory` tool definitions).
- **`pi-self-learning` source**: `~/.theoses/agent/npm/node_modules/pi-self-learning` (README + `extensions/self-learning.ts`, 2560 lines) — read for the promotion-boundary ticket, now a settled non-factor for Theoses2's design.
- Existing CLI slash-command convention: `packages/coding-agent/src/core/slash-commands.ts` — flat kebab-case names (`session`, `scoped-models`, etc.), used as precedent for the new `working-note` inspection command's name.
- Pi's token-estimation heuristic: `packages/agent/src/harness/compaction/compaction.ts` (`estimateTokens`, `shouldCompact`, `reserveTokens`/`keepRecentTokens` settings).

## Working notes on this session's texture

- The user corrected two of my assumptions early (Mino's `remember`/`save_note` split, and the existence of `pi-self-learning`) — both corrections changed the shape of ticket #17 substantially, from a speculative "what should the boundary be" question into a grounded one once the actual mechanics were read from source.
- Ticket #18's numbers were negotiated live: proposed token units, user considered it then rejected the resulting size jump (8x) as too much, reconsidered switching units at all once told Pi's "tokens" are just chars/4 with no precision benefit, then settled on staying in chars with a round 2x bump (4000/2000) over Mino's baseline (2000/1500).
- Both tickets this session were opened, argued through in conversation, resolved, and closed within the same session — issue #1's map was updated immediately after each closure rather than batched.
