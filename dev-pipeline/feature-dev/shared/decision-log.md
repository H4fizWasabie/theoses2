# Theoses Decision Log

Short accepted decisions live here. Detailed reasoning belongs in stage design artifacts.

### Theoses owns the Pi runtime snapshot
Date: 2026-09-01
Decision: Theoses owns and tracks the Pi `v0.84.3` source snapshot inside this repository.
Future Pi changes are optional manual imports, not automatic updates.
Because: Context and assistant behaviour are product decisions that must be changeable in
Theoses without depending on upstream release cadence.
Instead of: Continuing to consume Pi's published runtime packages as the authority.

### Theoses keeps an append-only session record
Date: 2026-09-01
Decision: Preserve session history for audit and recovery while allowing the model-facing
context to become curated and bounded.
Because: Durable history and useful prompt context have different needs.
Instead of: Treating the full session file as the prompt on every turn.

## Do not build yet

- Do not redesign context before the owned runtime baseline is verified.
- Do not delete Pi capabilities until Theoses' actual call sites and tests show they are
  unnecessary.
- Do not deploy a runtime ownership change before local and live-safe verification.
