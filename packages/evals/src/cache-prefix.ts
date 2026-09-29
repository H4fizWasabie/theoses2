// Where do two consecutive provider requests stop sharing a prefix? A provider's prompt cache can only reuse
// what is byte-identical from the start, so the first differing message is where the cache ends.

export type PrefixStep = {
	/** Index of the later request in the captured list. */
	request: number;
	/** The later request opens a new user turn (its last message is a user message the earlier one did not have). */
	turnStart: boolean;
	/** Messages the two requests share, from the start. */
	sharedMessages: number;
	messagesBefore: number;
	messagesAfter: number;
	/** Characters of the later request's messages that lie before the first difference / in total. */
	charsBeforeDiff: number;
	charsTotal: number;
	/** Role of the first differing message in the later request, and which of its fields differ. */
	roleAtDiff?: string;
	fieldsAtDiff?: string[];
	/** True when everything outside the messages (tools, model, options) is identical. */
	otherFieldsEqual: boolean;
};

function messagesOf(payload: unknown): unknown[] {
	const record = payload as Record<string, unknown>;
	const list = record.messages ?? record.input;
	return Array.isArray(list) ? list : [];
}

function withoutMessages(payload: unknown): string {
	const { messages: _messages, input: _input, ...rest } = payload as Record<string, unknown>;
	return JSON.stringify(rest);
}

function roleOf(message: unknown): string | undefined {
	const role = (message as { role?: unknown } | undefined)?.role;
	return typeof role === "string" ? role : undefined;
}

export function analyzePrefixes(payloads: unknown[]): PrefixStep[] {
	const steps: PrefixStep[] = [];
	for (let i = 1; i < payloads.length; i++) {
		const before = messagesOf(payloads[i - 1]);
		const after = messagesOf(payloads[i]);
		let shared = 0;
		while (
			shared < before.length &&
			shared < after.length &&
			JSON.stringify(before[shared]) === JSON.stringify(after[shared])
		) {
			shared++;
		}
		const sizes = after.map((message) => JSON.stringify(message).length);
		const differing = after[shared] as Record<string, unknown> | undefined;
		const previous = before[shared] as Record<string, unknown> | undefined;
		steps.push({
			request: i,
			turnStart: roleOf(after.at(-1)) === "user" && roleOf(before.at(-1)) !== "user",
			sharedMessages: shared,
			messagesBefore: before.length,
			messagesAfter: after.length,
			charsBeforeDiff: sizes.slice(0, shared).reduce((a, b) => a + b, 0),
			charsTotal: sizes.reduce((a, b) => a + b, 0),
			roleAtDiff: roleOf(differing),
			fieldsAtDiff:
				differing && previous
					? [...new Set([...Object.keys(differing), ...Object.keys(previous)])].filter(
							(key) => JSON.stringify(differing[key]) !== JSON.stringify(previous[key]),
						)
					: undefined,
			otherFieldsEqual: withoutMessages(payloads[i - 1]) === withoutMessages(payloads[i]),
		});
	}
	return steps;
}
