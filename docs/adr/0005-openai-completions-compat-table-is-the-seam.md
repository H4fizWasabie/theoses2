# The compat table is the seam for OpenAI-completions provider quirks

`packages/ai/src/api/openai-completions.ts` is 1,784 lines and looks like a single module branching on provider names. An architecture review proposed isolating each provider quirk behind its own module. We decided not to.

The quirks are already localised. `detectCompat` maps provider and base URL to about 25 capability flags, `getCompat` overlays the model's explicit `compat` on top, and the request path reads those flags (`compat.supportsStrictMode`, `compat.requestParallelToolCalls`, and so on) instead of checking provider names. Recent quirk fixes, such as disabling strict JSON-schema mode for DeepSeek served through aggregators and requesting parallel tool calls on OpenRouter, each landed as a flag in that table. The file is large because it also holds message conversion, streaming assembly and usage parsing for the whole API, not because quirk handling is scattered. Thirteen test files cover it.

A handful of raw provider checks remain in the request path (the opencode-go reasoning-field rename in streaming and replay, github-copilot dynamic headers, the `api.openai.com` prompt-cache key, OpenAI tool-call id truncation). Each serves one or two providers; turning them into flags would add flags with a single user each, so they stay as they are until a third provider needs the same behaviour.

Known and accepted cost: adding a flag touches three places (the compat type, `detectCompat`, and `getCompat`'s explicit per-key merge). Collapsing the merge to a spread of the model's defined keys would cut that to two, but trades per-key type checking for about 25 fewer lines; not worth doing unprompted.

Revisit if a quirk needs behaviour that cannot be expressed as a flag read, or if flag additions start to be routinely missed in one of the three places.
