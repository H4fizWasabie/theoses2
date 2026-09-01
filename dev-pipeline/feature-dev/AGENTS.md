# Theoses Feature Development Pipeline

Use this workspace for non-trivial Theoses runtime, context, provider, tool, or UI
behaviour changes. It takes one change from scoped idea to verified, documented code,
with a human review point between stages.

## Pipeline

```text
01-intake -> 02-design -> 03-implement -> 04-verify -> 05-ship
```

Each stage writes a resumable artifact to its `output/` folder. The next stage reads that
artifact. A human may edit the artifact before the next stage begins.

## Rules

- Use the full pipeline for runtime or context changes.
- Issue-first: record the originating issue or decision in the intake artifact.
- Do not implement before the design artifact is accepted.
- Stage 04 is mandatory for every code change.
- Stage 05 records user-visible changes, docs, and known limitations.
- Commit at meaningful milestones; do not bundle unrelated changes.
- Do not push, deploy, or alter the live service without explicit approval for that boundary.

## Resume

Run `status` first. The stage whose `output/` contains the latest artifact is the current
resume point. Read that artifact and its stage `CONTEXT.md` before continuing.

## Stage routing

| Need | Location |
|---|---|
| Scope an idea | `stages/01-intake/CONTEXT.md` |
| Design interfaces and data flow | `stages/02-design/CONTEXT.md` |
| Implement code and tests | `stages/03-implement/CONTEXT.md` |
| Verify behaviour | `stages/04-verify/CONTEXT.md` |
| Document a verified change | `stages/05-ship/CONTEXT.md` |

The pipeline is process infrastructure. The Pi source and Theoses application remain in
their normal repository locations, not inside stage folders.
