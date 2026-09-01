# Theoses / Pi Engine Handoff

## Current boundary

Theoses is the web UI/UX wrapper and event/input bridge. It is not the Pi
coding-agent runtime. The Pi runtime is being treated as a separate owned
engine that will eventually be trimmed and redesigned. UI redesign is out of
scope until the engine direction is settled.

```text
/home/hafiz/Desktop/Theoses  -> Theoses web wrapper
/home/hafiz/Desktop/pi       -> Pi-derived engine source
```

## Completed

- Theoses no longer has the nested `pi/` source directory.
- The Pi source was moved to `/home/hafiz/Desktop/pi`.
- Pi history was preserved at commit `4e58f324fae8ebfa98a3d45181fb248072a2afac`,
  tag `v0.84.3`.
- Theoses still consumes its existing pinned `0.84.3` npm packages.
- Theoses' `upstream` Git remote was removed earlier; its `origin` remains the
  Theoses repository.

## User's intended engine

Build a powerful personal assistant on the Pi engine without losing coding
capabilities:

- autonomous execution by default; no approval prompts for ordinary work;
- confirm before deletion or similarly irreversible destructive actions;
- bounded, relevance-based context instead of unbounded history growth;
- preserve Pi's strong coding, tools, providers, sessions, branching, and
  compaction capabilities where useful;
- reuse Mino's memory, consolidation/distillation, schedules, and Telegram
  capabilities where they fit the engine boundary;
- one continuous assistant with capability modes, not separate agents.

The raw session history should remain a complete record. Curated durable
memory should be stored separately and retrieved selectively.

## Current working-tree state

Theoses has pre-existing uncommitted work:

- `AGENTS.md` modified;
- `dev-pipeline/feature-dev/` added for tracked implementation stages.

Do not discard or reset these changes. `/home/hafiz/Desktop/pi` is a separate
Git repository and is currently a shallow detached checkout of `v0.84.3`.

## Next session instructions

1. Read `AGENTS.md` and this handoff.
2. Inspect both repositories and their package boundaries before editing.
3. Do not redesign Theoses UI yet.
4. First settle the engine ownership/layout decision: whether Pi becomes an
   independent fork/package/repository and how Theoses consumes that owned
   runtime.
5. Then map the minimum engine changes for bounded context and Mino memory.
6. Keep schedules and Telegram as later engine integrations, not Theoses UI
   features.

The next session should discuss and confirm the engine map before changing
code or package resolution.
