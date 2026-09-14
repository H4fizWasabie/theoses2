# AI and provider architecture

Status labels in this document follow [README.md](README.md). This subsystem was traced from the current TypeScript source; the package README is used only to identify stated intent.

## Responsibility boundary — Verified

`theoses-ai` exposes a provider-neutral conversation and streaming contract. Known chat API identifiers include OpenAI Completions, OpenAI Responses, Anthropic Messages, Bedrock Converse, Google, Mistral, Azure Responses, OpenAI Codex Responses, and Theoses Messages; the type remains open to custom API strings. Provider identifiers are likewise open-ended after the built-in union ([packages/ai/src/types.ts](../packages/ai/src/types.ts), `KnownApi`/`KnownProvider`, lines 17-76).

`Models` is the runtime collection. It stores providers by unique id, returns last-known model lists, resolves a model to its owning provider, applies authentication and request overrides, and delegates streaming, completion, and deferred-response operations. A provider owns its model list, auth methods, optional dynamic refresh, optional credential-specific filtering, and one or more `ProviderStreams` implementations ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `Provider`/`Models` contracts, lines 97-228).

The source therefore has three useful layers:

1. `ModelsImpl` handles collection state, auth, refresh generations, publication ordering, and dispatch ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `ModelsImpl`, lines 254-733).
2. Provider factories bind provider id, base URL, model catalog, auth, and API implementation. `createProvider` can dispatch one stream implementation to all models or select one by `model.api`; absent API entries produce a stream error ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `createProvider`, lines 739-862).
3. API modules translate the common `Context` and stream contract into upstream wire protocols. Lazy wrappers load API modules on first use and turn setup/import failures into terminal stream errors ([packages/ai/src/api/lazy.ts](../packages/ai/src/api/lazy.ts), `lazyStream`/`lazyApi`, lines 31-98).

## Request and response model — Verified

`Context` contains an optional system prompt, ordered messages, and optional tool definitions. Messages are user, assistant, or tool-result records. Assistant output carries provider/model identity, content blocks, usage/cost, stop reason, optional response/deferred identifiers, diagnostics, and an error message. The stream event protocol emits start, text/thinking/tool-call deltas and ends with either `done` or `error` ([packages/ai/src/types.ts](../packages/ai/src/types.ts), `Context`, message types, and `AssistantMessageEvent`, lines 314-558).

Common request options include an abort signal, telemetry parent, API key, injectable fetch, provider-scoped environment, payload/response hooks, headers, timeout, retries, cache retention, session id, transport, and metadata. API-specific options are selected through `ApiOptionsMap`; image generation has a separate `ImagesContext`/`AssistantImages` contract ([packages/ai/src/types.ts](../packages/ai/src/types.ts), `ProviderRequestOptions`/`StreamOptions`/`ApiOptionsMap`, lines 118-305 and 469-490).

`Models.stream()` returns a stream immediately. The lazy stream then resolves auth, merges request overrides, loads any lazy API module, and forwards events. `complete()` is the same path followed by `stream.result()`. Unknown providers fail with `ModelsError("provider")`; unconfigured providers fail with `ModelsError("auth")`; an API implementation missing for a model fails through the returned stream ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `applyAuth`/`stream`/`complete`, lines 636-688 and `createProvider` dispatch, lines 781-792).

## Provider catalog and refresh — Verified/partial

`builtinProviders()` constructs 39 chat providers, including regional variants and subscription-backed providers; `builtinModels()` registers each in a new `Models` collection. Static catalog data is read from the generated model map, while generated aggregators and provider shards are excluded from the ledger as generated output. Image built-ins currently register one OpenRouter image provider ([packages/ai/src/providers/all.ts](../packages/ai/src/providers/all.ts), `builtinProviders`/`builtinModels`/image factories, lines 50-155; generated catalog writes, [packages/ai/scripts/generate-models.ts](../packages/ai/scripts/generate-models.ts), lines 2907-2942).

### Catalog generation — Verified

`generate-models.ts` builds provider model values, groups the internal data by API for type derivation, writes one JSON file per provider plus `.manifest.json`, validates the staged directory, then atomically replaces `src/providers/data/`. It also writes the provider `.models.ts` shards and `src/models.generated.ts`. `model-data.ts` derives provider ids from the generated aggregator, requires the matching shard and JSON sets, validates model metadata and manifest hashes, and is exercised by `check-model-data.ts` ([packages/ai/scripts/generate-models.ts](../packages/ai/scripts/generate-models.ts), lines 2827-2967; [packages/ai/scripts/model-data.ts](../packages/ai/scripts/model-data.ts), `readModelDataStructure`/`validateModelDataDirectory`, lines 85-116 and 193-271; [packages/ai/scripts/check-model-data.ts](../packages/ai/scripts/check-model-data.ts), lines 1-16).

The checked-in provider JSON files and `.models.ts` shards are therefore generated artifacts, not independent provider implementations. Their source-of-truth behavior is the generator and validation path; the runtime still consumes their emitted values through `flattenModelCatalog` ([packages/ai/src/model-catalog.ts](../packages/ai/src/model-catalog.ts), lines 1-67). The JSON catalog directory is not tracked at the current revision, while the 39 tracked shard files are explicitly excluded in [14-file-inventory.md](14-file-inventory.md).

`createProvider` keeps baseline models and overlays dynamic models by id. `Models.refresh()` runs refreshable providers concurrently, restores cached model state before network access, resolves credentials, publishes model state through a generation-checked serialized publication chain, and returns per-provider errors rather than rejecting ordinary provider failures. Aborting or replacing a provider supersedes its generation and aborts its controller ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `refresh` and publication methods, lines 320-446; `createProvider` refresh overlay, lines 801-826).

The API adapter files are now source-read and individually marked in [14-file-inventory.md](14-file-inventory.md). Provider-factory-specific behavior, focused-test reconciliation, and deployment usage remain open. Generated catalog shards are excluded separately because they have no independent control flow.

Two non-standard provider families have explicit extra behavior. Cloudflare providers merge API key/account/gateway values per field and materialize URL placeholders before dispatch; the AI Gateway factory multiplexes three API implementations ([packages/ai/src/providers/cloudflare-auth.ts](../packages/ai/src/providers/cloudflare-auth.ts), `resolveCloudflareEnv`/auth factories, lines 31-103; [packages/ai/src/providers/cloudflare-stream.ts](../packages/ai/src/providers/cloudflare-stream.ts), `resolveCloudflareModel`/`cloudflareStreams`, lines 6-28; [packages/ai/src/providers/cloudflare-ai-gateway.ts](../packages/ai/src/providers/cloudflare-ai-gateway.ts), lines 9-22). Radius is dynamic: it validates gateway configuration, restores persisted or legacy OAuth catalogs, and fetches `/v1/config` when network access is allowed ([packages/ai/src/providers/radius-config.ts](../packages/ai/src/providers/radius-config.ts), lines 24-100; [packages/ai/src/providers/radius.ts](../packages/ai/src/providers/radius.ts), `refreshModels`, lines 18-81).

The provider factories read in this pass bind as follows:

| API implementation | Verified factories |
|---|---|
| OpenAI Completions | Ant Ling, Baseten, Cerebras, DeepSeek, Groq, Hugging Face, Moonshot AI, Moonshot AI CN, NVIDIA, OpenRouter, Qwen Token Plan, Qwen Token Plan CN, Qwen Token Plan Individual, Together, Xiaomi, Xiaomi Token Plan AMS/CN/SGP, and Z.AI/Z.AI Coding CN |
| Anthropic Messages | Anthropic, Kimi Coding, MiniMax, MiniMax CN, and Vercel AI Gateway |
| OpenAI Responses | OpenAI and xAI |
| Azure OpenAI Responses | Azure OpenAI |
| Mistral Conversations | Mistral |
| Mixed by model API | Fireworks, OpenCode Zen, OpenCode Go, and Cloudflare AI Gateway |
| Cloudflare-wrapped OpenAI Completions | Cloudflare Workers AI |
| Bedrock Converse | Amazon Bedrock |
| Google Generative AI | Google |
| Google Vertex | Google Vertex AI |
| OpenAI Codex Responses | OpenAI Codex |
| Theoses Messages | Radius |

Each factory uses `createProvider`, a catalog module, a lazy API wrapper, and either standard environment-key auth or an explicit provider auth object. The bindings above are directly visible in their provider files; the remaining factory files are still ledger work.

## API adapter behavior — Verified

The adapters share the same `AssistantMessageEventStream` contract but do not share one wire protocol:

- **Anthropic Messages** creates the SDK client, resolves OAuth/API-key request shape, converts system/user/assistant/tool messages, supports thinking and cache/tool compatibility, and maps streamed blocks and stop reasons ([packages/ai/src/api/anthropic-messages.ts](../packages/ai/src/api/anthropic-messages.ts), `stream`/`streamSimple`, lines 501-871; request conversion and mapping, lines 973-1391).
- **OpenAI Chat Completions** is the broad compatibility adapter. It selects provider-specific compatibility rules, applies cache-control and reasoning formats, converts messages/tools, incrementally parses text/thinking/tool/custom-tool deltas, and maps usage/finish/error responses ([packages/ai/src/api/openai-completions.ts](../packages/ai/src/api/openai-completions.ts), `stream`/`streamSimple`, lines 281-719; request/conversion/compatibility, lines 720-1736).
- **OpenAI Responses** delegates common input/tool/event handling to `openai-responses-shared`, then adds OpenAI client configuration, prompt-cache retention, deferred tools, Copilot headers, and service-tier pricing ([packages/ai/src/api/openai-responses-shared.ts](../packages/ai/src/api/openai-responses-shared.ts), conversion and stream processing, lines 138-792; [packages/ai/src/api/openai-responses.ts](../packages/ai/src/api/openai-responses.ts), lines 103-376). Azure reuses the same shared path after resolving resource/deployment/base URL configuration ([packages/ai/src/api/azure-openai-responses.ts](../packages/ai/src/api/azure-openai-responses.ts), lines 70-338).
- **OpenAI Codex Responses** adds a separate ChatGPT backend transport. It tries WebSocket, caches session continuations by session/account, falls back to SSE on transport failures, compresses SSE request bodies with zstd when available, retries selected failures, and feeds normalized events into the shared Responses processor ([packages/ai/src/api/openai-codex-responses.ts](../packages/ai/src/api/openai-codex-responses.ts), `stream`/`streamSimple` and request body, lines 188-551; transport/cache/parsing, lines 612-1504).
- **Google Generative AI and Vertex** share Gemini content/tool conversion, thought-signature retention, strict/tool-choice mapping, finish mapping, and SDK retry. The API-key adapter uses `GoogleGenAI`; Vertex additionally supports API-key or ADC, project/location resolution, and custom endpoint configuration ([packages/ai/src/api/google-shared.ts](../packages/ai/src/api/google-shared.ts), lines 32-452; [packages/ai/src/api/google-generative-ai.ts](../packages/ai/src/api/google-generative-ai.ts), lines 50-524; [packages/ai/src/api/google-vertex.ts](../packages/ai/src/api/google-vertex.ts), lines 68-596).
- **Mistral Conversations** uses native fetch/SSE rather than the OpenAI client. It remaps common messages and tool calls to Mistral’s wire casing, normalizes tool ids, supports prompt-affinity caching and reasoning modes, and maps streamed usage/finish/errors ([packages/ai/src/api/mistral-conversations.ts](../packages/ai/src/api/mistral-conversations.ts), lines 122-936).
- **Bedrock Converse** uses the AWS SDK and custom middleware. It resolves region/credentials/proxy/endpoint behavior, translates content and tool results, preserves supported thinking signatures and cache points, streams Bedrock block events, and attaches provider diagnostics ([packages/ai/src/api/bedrock-converse-stream.ts](../packages/ai/src/api/bedrock-converse-stream.ts), lines 116-1327).
- **Theoses Messages** is a native SSE protocol. It posts `{ model, context, options }`, converts serialized events into the common stream, retains rewrite impact diagnostics, and requires a terminal event ([packages/ai/src/api/theoses-messages.ts](../packages/ai/src/api/theoses-messages.ts), converter/parser lines 176-344 and `stream`/`streamSimple`, lines 345-433).
- **Cross-adapter helpers** are behavior-bearing. `transformMessages` rewrites history at provider/model boundaries; constrained sampling validates strict JSON schemas and grammar inputs; the Cloudflare binding adapts a Workers AI Gateway binding to the fetch shape; and lazy wrappers defer module loading while preserving terminal stream errors ([packages/ai/src/api/transform-messages.ts](../packages/ai/src/api/transform-messages.ts), lines 1-235; [packages/ai/src/api/constrained-sampling.ts](../packages/ai/src/api/constrained-sampling.ts), lines 117-276; [packages/ai/src/api/cloudflare-gateway-binding.ts](../packages/ai/src/api/cloudflare-gateway-binding.ts), lines 79-191; [packages/ai/src/api/lazy.ts](../packages/ai/src/api/lazy.ts), lines 46-98).

The adapter source is therefore substantially mapped, but that does not prove every provider/model compatibility branch works in production. The remaining evidence is the focused test matrix, provider-factory callers, runtime configuration, and live provider behavior.

## Authentication — Verified

Auth is one type-tagged credential per provider: an API-key credential may carry provider-scoped environment values, while an OAuth credential carries refresh/access/expiry data. `CredentialStore.modify()` is the serialized read-modify-write path; `Models` uses it to prevent concurrent OAuth refreshes from racing ([packages/ai/src/auth/types.ts](../packages/ai/src/auth/types.ts), credential and store contracts, lines 14-94).

Resolution order is explicit: an API key passed for the request wins; otherwise a stored credential is used; only when no stored credential exists are ambient environment, AWS, or Google ADC sources consulted. A stored credential of an unsupported type does not silently fall back to ambient auth. OAuth tokens near expiry are refreshed under the credential-store lock, with a five-minute default validity window and a 15-second refresh timeout ([packages/ai/src/auth/resolve.ts](../packages/ai/src/auth/resolve.ts), `resolveProviderAuthWithSignal`/`resolveStoredOAuth`, lines 44-160).

Standard providers use `envApiKeyAuth`, where a stored key wins over the first configured environment variable. Non-standard providers supply their own resolver ([packages/ai/src/auth/helpers.ts](../packages/ai/src/auth/helpers.ts), `envApiKeyAuth`/`lazyOAuth`, lines 3-59). The environment map covers provider-specific API-key names; Vertex can report authenticated through ADC plus project/location, and Bedrock recognizes several ambient AWS credential sources. `getEnvApiKey()` intentionally returns an authentication marker rather than a secret for ambient-only cases ([packages/ai/src/env-api-keys.ts](../packages/ai/src/env-api-keys.ts), `getApiKeyEnvVars`/`findEnvKeys`/`getEnvApiKey`, lines 68-187).

Subscription OAuth is provider-specific but shares the device-code polling and PKCE helpers. Anthropic and OpenAI Codex use loopback/manual callback flows; GitHub Copilot, Kimi, Radius, and xAI use device authorization; OpenRouter exchanges PKCE for a permanent API key; Radius discovers its authorization endpoint from the configured gateway. OAuth modules validate callback or verification URLs, honor cancellation/expiry, refresh credentials, and convert them to provider request auth. They are dynamically loaded so browser bundles do not follow Node-only callback-server modules ([packages/ai/src/auth/oauth/device-code.ts](../packages/ai/src/auth/oauth/device-code.ts), lines 26-98; [packages/ai/src/auth/oauth/pkce.ts](../packages/ai/src/auth/oauth/pkce.ts), lines 9-33; [packages/ai/src/auth/oauth/load.ts](../packages/ai/src/auth/oauth/load.ts), lines 9-68; provider flows in [14-file-inventory.md](14-file-inventory.md)).

The default auth context reads non-empty process environment values and checks filesystem paths through dynamically loaded Node modules; browsers receive no filesystem-backed file existence ([packages/ai/src/auth/context.ts](../packages/ai/src/auth/context.ts), `defaultProviderAuthContext`, lines 19-44). Provider-scoped overrides take precedence over process environment, with a Bun `/proc/self/environ` fallback for a documented sandbox case ([packages/ai/src/utils/provider-env.ts](../packages/ai/src/utils/provider-env.ts), `getProviderEnvValue`, lines 41-51).

## Retry, cancellation, and cost — Verified

Provider retry recognizes explicit `x-should-retry` headers, then retries 408, 409, 429, and 5xx responses, with jittered exponential backoff. Server-requested delays are read from `retry-after-ms` or `retry-after` and capped at 60 seconds by default; the sleep is abortable ([packages/ai/src/utils/provider-retry.ts](../packages/ai/src/utils/provider-retry.ts), `isRetryableProviderError` through `retryProviderRequest`, lines 25-145).

Optional public signals are normalized to an operation-local signal. `raceWithAbortSignal` stops waiting while observing the abandoned promise so later rejection is handled ([packages/ai/src/utils/abort.ts](../packages/ai/src/utils/abort.ts), `operationSignal`/`raceWithAbortSignal`, lines 8-49).

`calculateCost()` selects the highest matching input tier, calculates input/output/cache components per million tokens, and charges one-hour Anthropic cache writes at twice the base input rate. Thinking support is model-driven: models without reasoning expose only `off`, while mapped levels determine supported and clamped values ([packages/ai/src/models.ts](../packages/ai/src/models.ts), `calculateCost`/`getSupportedThinkingLevels`/`clampThinkingLevel`, lines 878-931).

## Compatibility path — Legacy/Verified

`theoses-ai/compat` preserves the old global API. It registers built-in API implementations, keeps a registry that can be overridden by tests/extensions, injects environment API keys when no explicit key is supplied, and routes built-in models through the newer provider collection. The old `getModel`, `getModels`, and `getProviders` exports are explicitly deprecated. New code is intended to use `createModels()` and provider factories ([packages/ai/src/compat.ts](../packages/ai/src/compat.ts), registry and compatibility exports, lines 1-29 and 100-213; dispatch, lines 215-298).

## Image generation — Verified

Image generation is deliberately separate from chat models. `ImagesModels` owns image providers, resolves auth, merges request options, and returns an `AssistantImages` error value instead of rejecting generation failures. `createImagesProvider` serializes concurrent dynamic refreshes. The built-in registry lazily loads the OpenRouter image API and converts module-load failures into an error result ([packages/ai/src/images-models.ts](../packages/ai/src/images-models.ts), `ImagesModelsImpl`/`createImagesProvider`, lines 97-275; [packages/ai/src/providers/images/register-builtins.ts](../packages/ai/src/providers/images/register-builtins.ts), lines 9-50).

## Tests and remaining evidence

The test inventory contains provider-specific auth, request translation, retry, streaming, model-catalog, image, OAuth, and compatibility paths. The names are inventoried in [17-test-index.md](17-test-index.md), but this pass does not claim that each test was read, run, or mapped to a production behavior. The API, OAuth, provider-factory, and utility implementations are source-read; provider-by-provider test reconciliation and the remaining repository-wide inventory are still required before the completion gate can pass.
