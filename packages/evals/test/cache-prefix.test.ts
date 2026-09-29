import { describe, expect, it } from "vitest";
import { analyzePrefixes } from "../src/cache-prefix.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string, reasoning?: string) => ({
	role: "assistant",
	content,
	...(reasoning ? { reasoning } : {}),
});
const request = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
	model: "m",
	tools: ["t"],
	messages,
	...extra,
});

describe("analyzePrefixes", () => {
	it("reports a full shared prefix when a request only appends", () => {
		const first = request([user("a"), assistant("b")]);
		const second = request([user("a"), assistant("b"), user("c")]);

		const [step] = analyzePrefixes([first, second]);

		expect(step).toMatchObject({ sharedMessages: 2, turnStart: true, otherFieldsEqual: true });
		expect(step.roleAtDiff).toBe("user");
		expect(step.charsBeforeDiff).toBeGreaterThan(0);
	});

	it("finds the first message whose fields changed, and which fields", () => {
		const first = request([user("a"), assistant("b", "long reasoning"), user("c")]);
		const second = request([user("a"), assistant("b"), user("c"), user("d")]);

		const [step] = analyzePrefixes([first, second]);

		expect(step.sharedMessages).toBe(1);
		expect(step.roleAtDiff).toBe("assistant");
		expect(step.fieldsAtDiff).toEqual(["reasoning"]);
		expect(step.charsBeforeDiff).toBeLessThan(step.charsTotal);
	});

	it("is not a turn start when the later request continues an unfinished turn", () => {
		const first = request([user("a")]);
		const second = request([user("a"), assistant("b"), { role: "tool", content: "r" }]);

		expect(analyzePrefixes([first, second])[0].turnStart).toBe(false);
	});

	it("notices a change outside the messages", () => {
		const [step] = analyzePrefixes([request([user("a")]), request([user("a")], { tools: ["t", "u"] })]);

		expect(step.otherFieldsEqual).toBe(false);
		expect(step.sharedMessages).toBe(1);
	});
});
