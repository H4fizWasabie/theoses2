# Theoses Feature Development Workspace

Read `AGENTS.md` first. This workspace manages one scoped Theoses change through reviewable
intake, design, implementation, verification, and documentation.

| Task | Stage |
|---|---|
| Scope an idea or architecture change | `stages/01-intake/CONTEXT.md` |
| Define interfaces and failure behaviour | `stages/02-design/CONTEXT.md` |
| Write code and tests | `stages/03-implement/CONTEXT.md` |
| Verify local and live-safe behaviour | `stages/04-verify/CONTEXT.md` |
| Update changelog and docs | `stages/05-ship/CONTEXT.md` |

Pure documentation corrections may enter at stage 05. A known-cause bug may enter at stage
03, but still requires stages 04 and 05. Architecture-only work runs stages 01 and 02, then
stops for approval.

Each stage's `output/` folder is the handoff and resume mechanism. Do not clear an unfinished
output folder.
