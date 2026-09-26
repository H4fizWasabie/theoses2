# Turn Settlement does not own its workers' concurrency

`turn-settlement.ts` is a short dispatch: after a completed Channel Session turn it hands off to memory promotion and to task-boundary detection. An architecture review proposed that settlement own single-flight, error logging and a "next turn already started" leaf check for every worker, with workers reduced to snapshot-in, entries-out. We rejected it.

The concerns are not the same across workers. Memory promotion needs single-flight and a failure cooldown across both of its triggers (compaction and settlement), so they belong to promotion, not to one of its callers. A promoted range names the entries it covers by id, so where it lands in the log does not matter; save_note and auto-compaction already append ranges mid-turn. The task-boundary detector's entries do depend on position (a descriptor belongs to the turn it follows), so only it needs the leaf check, and it has one. Moving these into settlement would give it a rule that only one worker needs and split promotion's concurrency across two modules.

Revisit if a third settlement worker appears whose entries depend on position, or if two workers need to be ordered or share a snapshot.
