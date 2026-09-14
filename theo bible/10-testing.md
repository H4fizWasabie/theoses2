# Testing

## Declared commands

Root CI runs `npm run build`, `npm run check`, and `npm test` after `npm ci --ignore-scripts` ([.github/workflows/ci.yml](../.github/workflows/ci.yml), lines 16-43). Root `package.json` also declares targeted script tests, model-data checks, browser smoke checks, pinned-dependency checks, and package-specific test scripts ([package.json](../package.json), `scripts`, lines 1-95).

## Test inventory

The tracked inventory contains 500 test/fixture-classified files. The path-by-path list is [17-test-index.md](17-test-index.md). Exact package counts are an inventory metric, not pass results; fixtures/helpers are included where the path classifier identifies them.

## Verified testable contracts

- Agent event sequencing, tool execution, steering, follow-up, abort, and continuation are documented and covered by `packages/agent/test` alongside the implementation ([packages/agent/src/agent-loop.ts](../packages/agent/src/agent-loop.ts), lines 152-275).
- Protocol schemas and AI-to-wire adapters are runtime-validated and have package tests; the server README states that adapter output is encoded through runtime schemas ([packages/server/README.md](../packages/server/README.md), “theoses-ai protocol bridge”).
- Client/server transport behavior is testable without a concrete network transport through testing exports ([packages/server/README.md](../packages/server/README.md), “Transport testing”).

## Verification performed for this Bible

- Read the supplied brief before continuing.
- Ran `rtk graphify update .`.
- Ran `rtk codegraph sync .` and `rtk codegraph status .`.
- Enumerated tracked files and package test filenames.
- Ran focused AI tests: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run packages/ai/test/models-runtime.test.ts packages/ai/test/provider-retry.test.ts packages/ai/test/oauth-auth.test.ts packages/ai/test/images-models.test.ts` — 4 files passed, 66 tests passed in 567 ms. This supports the documented core model collection, retry, OAuth, and image-collection contracts; it does not prove every provider adapter or integration path.
- Ran focused OAuth tests: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run packages/ai/test/oauth-device-code.test.ts packages/ai/test/oauth-auth.test.ts packages/ai/test/anthropic-oauth.test.ts packages/ai/test/openrouter-oauth.test.ts` — 4 files passed, 33 tests passed. This covers device-code polling, lazy auth resolution, Anthropic callback/refresh behavior, and OpenRouter PKCE/permanent-key behavior; it does not prove live provider OAuth.
- Checked all bible Markdown files for trailing whitespace and resolving relative links.

No implementation code was changed. The full build/check/test suite was not run because it is broader than the current evidence target and the repository instructions prohibit unnecessary full-suite runs.

## Verification not yet performed

No claim is made here that all 500 test/fixture files pass, that every CI workflow is green, or that the dashboard/Telegram flows were live-tested. Physical deployment, provider calls, Telegram delivery, and network transport interoperability remain unverified in this baseline.
