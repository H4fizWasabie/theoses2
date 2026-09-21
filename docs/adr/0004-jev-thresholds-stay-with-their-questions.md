# Jev thresholds and question wording stay in the module that asks them

Memory gate, remember relevance, task-boundary detection and consolidation each build their own Jev question list and own the probability threshold applied to the answer (`GATE_SAME_MIN_NOUL`, `RELEVANCE_MIN_NOUL`, `JEV_RELATED_THRESHOLD`). An architecture review proposed a shared "judgment module" holding questions, thresholds and debug flags behind one interface. We rejected it.

Each threshold was measured against one specific wording, and the evidence lives in that module's header comment: `RELEVANCE_MIN_NOUL = 0.4` was tuned on 240 hand-labelled pairs for "is this node about the subject of the query?" (a stricter wording lost relevant nodes at the same floor), and `GATE_SAME_MIN_NOUL = 0.85` was replayed over the 7,806-node production store. A number tuned with its wording only means something next to it; centralising thresholds would move complexity rather than concentrate it, so it fails the deletion test.

`jev-client.ts` is already the deep module at this seam: one shared failure path (`askJev`), three small functions on top, and the API key read in one place. Gate and relevance tests replace it wholesale with `vi.mock`, and its own tests stub `fetch`. Making that seam an injected parameter would only formalise what `vi.mock` already gives, since the only second "adapter" would be a test fake.

Revisit if a fourth or fifth caller appears that needs the same per-item "ask one noul per item, then threshold" pattern, or if the API key needs to come from somewhere other than the environment.
