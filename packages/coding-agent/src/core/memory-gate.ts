/**
 * The gate a fact passes before it is written to memory.
 *
 * Theoses's model is ephemeral: it does not remember what it saved yesterday, so it saves the same facts again in
 * new words. On 2026-09-19 about 6% of the active store (423 of 6,970 nodes) turned out to be such rewordings,
 * and the fact "Hafiz is the creator of Theoses and should be addressed as 'abah'" existed ten times. Both write
 * paths leaked: `save_note` checked nothing, and consolidation only caught a fact whose words were all contained
 * in a stored node, which a rewording is not.
 *
 * `check` decides in three steps, and only the third uses the network:
 *  1. a stored node already says everything the new text does (the conservative rule): reuse it;
 *  2. otherwise find up to GATE_MAX_CANDIDATES stored nodes that are likely restatements (word overlap with the
 *     same numbers and negations, so a changed port or a negated claim is never a candidate);
 *  3. ask Jev, in one request, whether the new text and each candidate "state the same fact".
 * A candidate scoring at least GATE_SAME_MIN_NOUL is the same fact. If the new text adds real detail it is written
 * and marked as superseding the old node, so the richer wording is the one shown; otherwise it is not written.
 *
 * It fails open: no key, a timeout or a malformed answer means "store it". Losing a real fact costs more than
 * keeping a duplicate, and the duplicates can still be cleaned up later.
 *
 * Replayed on 2026-09-20 over the 7,806 nodes of the production store in the order they were created, with real
 * Jev calls (about two cents): 7,141 stored, 596 blocked (7.6%) and 69 stored as a richer replacement. In a hand-read
 * sample of 34 blocked pairs all 34 were the same fact reworded (two had a minor detail on one side), so no new
 * fact was wrongly blocked; of 8 replacements, 7 were clearly richer and one was marginal. The gate would have kept
 * the store 7.6% smaller than it is, more than the 423 nodes the cleanup archived, because it also catches the
 * conservative-rule and chained duplicates. The 423 are not comparable one to one: the cleanup keeps the node with
 * the most links, the gate keeps the first to arrive, so it blocks a different member of the same group.
 */

import { askJevNouls } from "./jev-client.ts";
import { createDuplicateIndex, type DuplicateIndex, significantWordsAdded } from "./memory-dedup.ts";
import type { MemoryNode } from "./memory-store.ts";

/** How many stored candidates are compared with a new fact in one Jev request. */
export const GATE_MAX_CANDIDATES = 5;
/** Jev's probability that two texts state the same fact must be at least this. */
export const GATE_SAME_MIN_NOUL = 0.85;
/** A same-fact new text is written (and supersedes the old node) only if it adds at least this many significant words... */
export const GATE_SUPERSEDE_MIN_ADDED_WORDS = 3;
/** ...and is at least this many times as long. */
export const GATE_SUPERSEDE_MIN_LENGTH_RATIO = 1.3;
const GATE_TIMEOUT_MS = 4000;
const TEXT_MAX_CHARS = 420;

export type GateVerdict =
	| { action: "store" }
	/** A stored node already says this: do not write it, use `existing` instead. */
	| { action: "reuse"; existing: MemoryNode }
	/** The same fact in richer words: write it and mark it as superseding `existing`. */
	| { action: "supersede"; existing: MemoryNode };

export interface MemoryWriteGate {
	check(subject: string): Promise<GateVerdict>;
	/** Registers a node written after the gate was created, so later facts in the same batch are checked against it. */
	noteStored(node: MemoryNode): void;
}

/** On unless THEOSES_MEMORY_GATE=off: the check sends memory text to Jev. */
export function isMemoryGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.THEOSES_MEMORY_GATE !== "off";
}

/** Nodes that no other node marks as superseded; a hidden node is not something a new fact can duplicate. */
export function activeNodes(nodes: MemoryNode[]): MemoryNode[] {
	const hidden = new Set(
		nodes.flatMap((node) => node.edges.filter((edge) => edge.rel === "supersedes").map((edge) => edge.target)),
	);
	return nodes.filter((node) => !hidden.has(node.id));
}

/** `jev: false` keeps only the conservative, network-free check (what THEOSES_MEMORY_GATE=off falls back to). */
export function createMemoryWriteGate(nodes: MemoryNode[], options: { jev?: boolean } = {}): MemoryWriteGate {
	const useJev = options.jev ?? true;
	const index: DuplicateIndex = createDuplicateIndex(activeNodes(nodes));
	return {
		noteStored(node) {
			index.add(node);
		},
		async check(subject) {
			const restated = index.findRestatement(subject);
			if (restated) return { action: "reuse", existing: restated };
			if (!useJev) return { action: "store" };

			const candidates = index.findCandidates(subject, GATE_MAX_CANDIDATES);
			if (candidates.length === 0) return { action: "store" };

			const names = candidates.map((_, i) => `c${i}`);
			const state = {
				new: subject.slice(0, TEXT_MAX_CHARS),
				existing: Object.fromEntries(
					candidates.map((node, i) => [names[i], node.subject.slice(0, TEXT_MAX_CHARS)]),
				),
			};
			const questions = Object.fromEntries(
				names.map((name) => [name, `Do \`new\` and \`existing.${name}\` state the same fact?`]),
			);
			const scores = await askJevNouls(state, questions, { timeoutMs: GATE_TIMEOUT_MS });
			if (scores === undefined) return { action: "store" };

			let best = 0;
			for (let i = 1; i < candidates.length; i++) if (scores[names[i]] > scores[names[best]]) best = i;
			if (scores[names[best]] < GATE_SAME_MIN_NOUL) return { action: "store" };

			const existing = candidates[best];
			const richer =
				significantWordsAdded(subject, existing.subject) >= GATE_SUPERSEDE_MIN_ADDED_WORDS &&
				subject.length >= existing.subject.length * GATE_SUPERSEDE_MIN_LENGTH_RATIO;
			return richer ? { action: "supersede", existing } : { action: "reuse", existing };
		},
	};
}
