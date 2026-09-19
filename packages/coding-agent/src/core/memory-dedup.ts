/**
 * Detects memory nodes that restate a fact the store already has.
 *
 * Consolidation asks the model not to re-emit a fact that already exists, but it only sees a
 * keyword-narrowed handful of existing subjects, and recall itself fills up with restatements, so
 * the same fact gets written again and again. On the real store 901 of 7,954 nodes (11%) were
 * restatements, with some facts stored 8 to 12 times. This module is the code-level check: used at
 * write time to reuse the existing node, and by the dry-run report to show what already piled up.
 *
 * The rule is deliberately conservative, because merging a fact that actually changed destroys
 * information ("runs on port 8083" and "runs on port 8082" differ by one word). Two subjects are
 * duplicates only if, after lowercasing and dropping punctuation, they are identical; or if they are
 * long enough to be specific, share at least 85% of their significant words, contain exactly the same
 * words with digits in them, and agree on every negation word. Anything else is treated as a
 * different fact, which is what happened before this module existed.
 */
import type { MemoryNode } from "./memory-store.ts";

const NEAR_DUPLICATE_JACCARD = 0.85;
/** Below this many significant words a subject is too generic to trust word overlap; only exact matches merge. */
const MIN_WORDS_FOR_NEAR_MATCH = 4;
/** How many of a subject's rarest words are used to look up candidates. */
const CANDIDATE_LOOKUP_WORDS = 4;

const STOP_WORDS = new Set(
	"the a an and of to in for on with is are was were be by at as it its that this from or has have had".split(" "),
);
/** A restatement that flips one of these is a different claim, not the same fact worded differently. */
const NEGATION_WORDS = new Set([
	"not",
	"no",
	"never",
	"without",
	"cannot",
	"cant",
	"dont",
	"doesnt",
	"didnt",
	"wont",
	"isnt",
	"arent",
	"wasnt",
	"disabled",
	"disable",
	"off",
]);

export function normalizeSubject(subject: string): string {
	return subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

interface SubjectWords {
	normalized: string;
	/** Words that carry meaning: no stop words, more than two characters. Used for the overlap score. */
	significant: Set<string>;
	/** Every word that contains a digit, however short ("v4", "80", "2026"). */
	digitWords: Set<string>;
	negations: Set<string>;
}

const wordsCache = new WeakMap<object, SubjectWords>();

function subjectWords(subject: string): SubjectWords {
	const normalized = normalizeSubject(subject);
	const all = normalized === "" ? [] : normalized.split(" ");
	return {
		normalized,
		significant: new Set(all.filter((word) => word.length > 2 && !STOP_WORDS.has(word))),
		digitWords: new Set(all.filter((word) => /\d/.test(word))),
		negations: new Set(all.filter((word) => NEGATION_WORDS.has(word))),
	};
}

function wordsOf(node: MemoryNode): SubjectWords {
	let words = wordsCache.get(node);
	if (!words) {
		words = subjectWords(node.subject);
		wordsCache.set(node, words);
	}
	return words;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

function isSubset(part: Set<string>, whole: Set<string>): boolean {
	for (const item of part) if (!whole.has(item)) return false;
	return true;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

/** Whether two subjects state the same fact under the conservative rule described at the top of the file. */
export function areDuplicateSubjects(a: string, b: string): boolean {
	return duplicateOf(subjectWords(a), subjectWords(b));
}

function duplicateOf(a: SubjectWords, b: SubjectWords): boolean {
	if (a.normalized === "" || b.normalized === "") return false;
	if (a.normalized === b.normalized) return true;
	if (a.significant.size < MIN_WORDS_FOR_NEAR_MATCH || b.significant.size < MIN_WORDS_FOR_NEAR_MATCH) return false;
	if (!sameSet(a.digitWords, b.digitWords)) return false;
	if (!sameSet(a.negations, b.negations)) return false;
	return jaccard(a.significant, b.significant) >= NEAR_DUPLICATE_JACCARD;
}

/** Share of significant words two subjects must have in common to count as the same fact when ranking results. */
export const LIKELY_RESTATEMENT_JACCARD = 0.5;

/**
 * A looser cousin of `areDuplicateSubjects` for choosing which results to show, not for merging or archiving:
 * two subjects that use the same numbers and the same negations and share at least `minJaccard` of their
 * significant words are almost always the same fact reworded ("Hafiz is the creator of Theoses and should be
 * addressed as 'abah'" against "The user is abah (Hafiz), creator of Theoses"). Of 40 pairs it flagged in the
 * production store and read by hand, about 35 were true restatements and none was clearly a different fact.
 * Showing only one of them costs a lookup one redundant result; it changes nothing that is stored.
 */
export function areLikelyRestatements(a: string, b: string, minJaccard: number = LIKELY_RESTATEMENT_JACCARD): boolean {
	const wordsA = subjectWords(a);
	const wordsB = subjectWords(b);
	if (wordsA.normalized === "" || wordsB.normalized === "") return false;
	if (wordsA.normalized === wordsB.normalized) return true;
	if (wordsA.significant.size < MIN_WORDS_FOR_NEAR_MATCH || wordsB.significant.size < MIN_WORDS_FOR_NEAR_MATCH) {
		return false;
	}
	if (!sameSet(wordsA.digitWords, wordsB.digitWords) || !sameSet(wordsA.negations, wordsB.negations)) return false;
	return jaccard(wordsA.significant, wordsB.significant) >= minJaccard;
}

export interface DuplicateIndex {
	/** The stored node this subject is a duplicate of in either direction, or undefined. Earliest wins on ties. */
	find(subject: string): MemoryNode | undefined;
	/**
	 * Like `find`, but only a stored node that already says everything this subject does: every
	 * significant word of the subject appears in the node. Reusing that node loses nothing, so this is
	 * what write-time prevention uses. A subject that adds words ("the delta landing page" against "the
	 * landing page") is a new, more specific fact and is not matched.
	 */
	findRestatement(subject: string): MemoryNode | undefined;
	/** Registers a node so later subjects (including ones in the same consolidation response) match it. */
	add(node: MemoryNode): void;
}

/** Lookup structure over existing nodes: exact by normalized text, near by the rarest words of the subject. */
export function createDuplicateIndex(nodes: Iterable<MemoryNode> = []): DuplicateIndex {
	const byNormalized = new Map<string, MemoryNode>();
	const byWord = new Map<string, MemoryNode[]>();
	const earlier = (a: MemoryNode, b: MemoryNode): boolean => a.at < b.at || (a.at === b.at && a.id < b.id);

	const search = (
		subject: string,
		accept: (words: SubjectWords, candidate: SubjectWords) => boolean,
	): MemoryNode | undefined => {
		const words = subjectWords(subject);
		if (words.normalized === "") return undefined;
		const exact = byNormalized.get(words.normalized);
		if (exact) return exact;
		if (words.significant.size < MIN_WORDS_FOR_NEAR_MATCH) return undefined;

		const rarest = [...words.significant]
			.map((word) => ({ word, nodes: byWord.get(word) ?? [] }))
			.filter((entry) => entry.nodes.length > 0)
			.sort((x, y) => x.nodes.length - y.nodes.length)
			.slice(0, CANDIDATE_LOOKUP_WORDS);
		let best: MemoryNode | undefined;
		let bestScore = 0;
		const seen = new Set<MemoryNode>();
		for (const { nodes: candidates } of rarest) {
			for (const candidate of candidates) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				const candidateWords = wordsOf(candidate);
				if (!duplicateOf(words, candidateWords) || !accept(words, candidateWords)) continue;
				const score = jaccard(words.significant, candidateWords.significant);
				if (!best || score > bestScore || (score === bestScore && earlier(candidate, best))) {
					best = candidate;
					bestScore = score;
				}
			}
		}
		return best;
	};

	const index: DuplicateIndex = {
		add(node) {
			const words = wordsOf(node);
			if (words.normalized === "") return;
			const held = byNormalized.get(words.normalized);
			if (!held || earlier(node, held)) byNormalized.set(words.normalized, node);
			for (const word of words.significant) {
				const list = byWord.get(word);
				if (list) list.push(node);
				else byWord.set(word, [node]);
			}
		},
		find(subject) {
			return search(subject, () => true);
		},
		findRestatement(subject) {
			return search(subject, (words, candidate) => isSubset(words.significant, candidate.significant));
		},
	};
	for (const node of nodes) index.add(node);
	return index;
}

export interface DedupNodeSummary {
	id: string;
	subject: string;
	at: string;
}

export interface DuplicateRemoval extends DedupNodeSummary {
	/**
	 * Significant words this node has that the kept node lacks. Empty means a pure restatement; anything
	 * else is more specific than what would be kept, so removing it loses those words. Review these.
	 */
	adds: string[];
}

export interface DuplicateGroup {
	/** The earliest node of the group: what a cleanup would keep. */
	keep: DedupNodeSummary;
	remove: DuplicateRemoval[];
}

export interface SupersededNode extends DedupNodeSummary {
	supersededBy: string[];
}

export interface MemoryDedupPlan {
	nodeCount: number;
	duplicateGroups: DuplicateGroup[];
	/** Nodes another node marks as superseded: already hidden from recall, still stored. */
	superseded: SupersededNode[];
	totals: {
		duplicateNodes: number;
		/** Of the duplicates, how many add words the kept node lacks (the ones to review by hand). */
		duplicatesAddingWords: number;
		supersededNodes: number;
		removableNodes: number;
	};
}

function summary(node: MemoryNode): DedupNodeSummary {
	return { id: node.id, subject: node.subject, at: node.at };
}

/**
 * A dry-run plan for the whole store, nothing is changed. Nodes are taken oldest first, and each one
 * that restates an earlier kept node joins that node's group, so the earliest statement of a fact is
 * the one a cleanup would keep. Superseded nodes are reported separately; a node can be both.
 */
export function planMemoryDedup(nodes: MemoryNode[]): MemoryDedupPlan {
	const ordered = [...nodes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
	const index = createDuplicateIndex();
	const groups = new Map<string, DuplicateGroup>();
	const removable = new Set<string>();
	for (const node of ordered) {
		const original = index.find(node.subject);
		if (!original || original.id === node.id) {
			index.add(node);
			continue;
		}
		let group = groups.get(original.id);
		if (!group) {
			group = { keep: summary(original), remove: [] };
			groups.set(original.id, group);
		}
		const keptWords = wordsOf(original).significant;
		group.remove.push({
			...summary(node),
			adds: [...wordsOf(node).significant].filter((word) => !keptWords.has(word)),
		});
		removable.add(node.id);
	}

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const supersededBy = new Map<string, string[]>();
	for (const node of nodes) {
		for (const edge of node.edges) {
			if (edge.rel !== "supersedes" || !byId.has(edge.target)) continue;
			const list = supersededBy.get(edge.target);
			if (list) list.push(node.id);
			else supersededBy.set(edge.target, [node.id]);
		}
	}
	const superseded = [...supersededBy.entries()]
		.map(([id, by]) => ({ ...summary(byId.get(id) as MemoryNode), supersededBy: by }))
		.sort((a, b) => (a.at < b.at ? -1 : 1));
	for (const node of superseded) removable.add(node.id);

	const duplicateGroups = [...groups.values()].sort((a, b) => b.remove.length - a.remove.length);
	return {
		nodeCount: nodes.length,
		duplicateGroups,
		superseded,
		totals: {
			duplicateNodes: duplicateGroups.reduce((sum, group) => sum + group.remove.length, 0),
			duplicatesAddingWords: duplicateGroups.reduce(
				(sum, group) => sum + group.remove.filter((removal) => removal.adds.length > 0).length,
				0,
			),
			supersededNodes: superseded.length,
			removableNodes: removable.size,
		},
	};
}
