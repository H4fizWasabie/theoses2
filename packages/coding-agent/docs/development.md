# Development

See [AGENTS.md](https://github.com/H4fizWasabie/theoses2/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/H4fizWasabie/theoses2
cd theoses-mono
npm install
npm run build
```

Run from source:

```bash
/path/to/theoses-mono/theoses-test.sh
```

The script can be run from any directory. Theoses keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "theosesConfig": {
    "name": "theoses",
    "configDir": ".theoses"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.theoses/agent/theoses-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Explorer code navigation

Background explorers have a structured `graft` tool alongside `read`, `grep`,
`find`, and `ls`. Use Graft first for code navigation:

- `{command: "ask", target: "retry"}` — ranked pointers with source excerpts (1–8 results).
- `{command: "skeleton", target: "src/retry.ts"}` — repository-relative file signatures.
- `{command: "callers", target: "retry", depth: 2}` — references, with depth capped at 3.

An optional `path` selects a repository outside the explorer's working directory.
Otherwise the nearest ancestor graph is used, without crossing an unindexed nested
Git repository. The parent must install Graft and prepare the repository graph
with `graft build`; explorers cannot install, build, refresh, or run arbitrary shell
commands. Queries use `--no-refresh`, so graphs may be stale: verify important
locations with `read`. Missing graph/binary returns a fallback notice, not evidence
that the code is absent. Process time and buffered output are bounded; results are
capped at 250 lines/6KB and honor cancellation. Graft's own CLI may maintain its
user-level update cache; automatic graph rebuilds and telemetry are disabled.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
