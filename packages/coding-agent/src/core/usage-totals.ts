import type { Usage } from "theoses-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** What a session's logs add up to. A rotated log's header carries the totals of what rotation dropped. */
export interface SessionTotals {
	usage: UsageTotals;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	compactions: number;
}

/** Whole-session totals: every entry of a log (every branch, history compacted away) plus `carried` from its header. */
export function sumSessionTotals(entries: readonly SessionEntry[], carried?: SessionTotals): SessionTotals {
	const totals: SessionTotals = {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		compactions: 0,
		...carried,
		usage: { ...createUsageTotals(), ...carried?.usage },
	};
	for (const entry of entries) {
		if (entry.type === "compaction") totals.compactions++;
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(totals.usage, entry.usage);
		}
		if (entry.type !== "message") continue;
		totals.totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			totals.userMessages++;
		} else if (message.role === "toolResult") {
			totals.toolResults++;
			if (message.usage) addUsageToTotals(totals.usage, message.usage);
		} else if (message.role === "assistant") {
			totals.assistantMessages++;
			if (Array.isArray(message.content)) {
				totals.toolCalls += message.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(totals.usage, message.usage);
		}
	}
	return totals;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket; `carried` (from logs
 * before a Log Rotation) is one bucket of its own. */
export function getUsageCostBreakdown(entries: SessionEntry[], carried?: UsageTotals): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();
	if (carried) totalsByKey.set("Earlier logs", { ...carried });

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
