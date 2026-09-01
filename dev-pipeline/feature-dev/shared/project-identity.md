# Theoses Project Identity

Theoses is a browser interface and runtime host for an owned Pi-derived agent. The Pi
runtime owns agent execution, providers, tools, sessions, and compaction. Theoses owns the
product boundary, context design, web presentation, and integration policy.

## Stack

| Item | Value |
|---|---|
| Runtime | Node.js and TypeScript |
| Web | Next.js |
| Agent source | `pi/` owned Pi `v0.84.3` snapshot |
| State | Pi session JSONL plus Theoses configuration |
| Dev server | `npm run dev` on port 30141 |
| Typecheck | `node_modules/.bin/tsc --noEmit` |
| Lint | `npm run lint` |
| Tests | `npm test` |

Do not run `next build` during development; it interferes with the dev server.
