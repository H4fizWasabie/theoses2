import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createDeferredToolDefinitions } from "../src/core/tools/deferred-dispatch.ts";

describe("deferred tool dispatcher", () => {
	it("searches, activates, and dispatches a registered tool", async () => {
		let activated: string[] = [];
		let called = "";
		const target: ToolDefinition = {
			name: "calendar_create",
			label: "calendar_create",
			description: "Create a calendar event",
			parameters: Type.Object({ title: Type.String() }),
			execute: async (_id, { title }) => {
				called = String(title);
				return { content: [{ type: "text", text: "created" }], details: undefined };
			},
		};
		const definitions = createDeferredToolDefinitions(
			() => new Map([[target.name, target]]),
			(names) => {
				activated = names;
			},
			{ get: () => 0, record: () => {} },
			async (_name, id, args) => target.execute(id, args, undefined, undefined, {} as ExtensionContext),
		);
		const context = {} as ExtensionContext;

		const searchResult = await definitions[0].execute("search", { query: "calendar" }, undefined, undefined, context);
		const callResult = await definitions[1].execute(
			"call",
			{ name: "calendar_create", args: { title: "Lunch" } },
			undefined,
			undefined,
			context,
		);

		expect(searchResult.content[0]).toMatchObject({ type: "text" });
		expect((searchResult.content[0] as { text: string }).text).toContain('"name":"calendar_create"');
		expect(activated).toEqual(["calendar_create"]);
		expect(called).toBe("Lunch");
		expect(callResult.content[0]).toMatchObject({ type: "text", text: "created" });
	});
});
