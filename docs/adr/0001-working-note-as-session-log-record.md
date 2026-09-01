# Working Note persisted as a Pi session-log record, not a separate store

Mino's precedent for this concept is a dedicated SQLite `session_notes` table, separate from its chat log. Theoses2 instead defines the Working Note as a new record type appended to Pi's existing, extensible session log (JSONL or sqlite backend), alongside Pi's other record types (`tool_started`, `queue_cancelled`, etc.).

We chose this because Pi is already event-sourced: its reducer reconstructs all session state, including mid-flight and aborted operations, by replaying the persisted record log on restart. A bespoke store for the Working Note would duplicate that restart-recovery machinery for no benefit. The trade-off is that the Working Note's current value is derived (folded from its entries by the reducer) rather than read directly from a single row — acceptable because Pi's reducer already does this kind of folding for other record types.

One consequence: durable-memory distillation of dropped turns is triggered off Pi's own compaction cut-point computation, not a separate turn-counter like Mino's, since Pi already computes exactly which messages are being dropped.
