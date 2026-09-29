import type { ThinkingLevel } from "theoses-agent-core";
import type { Model } from "theoses-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// Pins what every way of switching the model does (issue #418): setModel, cycling through scoped models, and
// cycling through all available models. They choose the next model differently and must do everything else the same.
type Path = "setModel" | "scopedCycle" | "availableCycle";
const PATHS: Path[] = ["setModel", "scopedCycle", "availableCycle"];

describe("AgentSession model switch, by entry point", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const events: string[] = [];
		/** What the saved default model was at the moment each model_select handler ran. */
		const defaultAtSelect: Array<string | undefined> = [];
		let current: Harness | undefined;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`select ${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
						defaultAtSelect.push(current?.settingsManager.getDefaultModel());
					});
				},
			],
		});
		current = harness;
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "thinking_level_changed") events.push(`level ${event.level}`);
		});
		return { harness, events, defaultAtSelect };
	}

	/** Moves from faux-1 to faux-2 the way `path` does. */
	async function switchToSecond(harness: Harness, path: Path, options: { persist?: boolean } = {}) {
		const second = harness.getModel("faux-2") as Model<string>;
		if (path === "setModel") {
			await harness.session.setModel(second, options);
			return undefined;
		}
		if (path === "scopedCycle") {
			harness.session.setScopedModels([{ model: harness.getModel("faux-1") as Model<string> }, { model: second }]);
		}
		return await harness.session.cycleModel("forward", options);
	}

	const modelChanges = (harness: Harness) =>
		harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "model_change")
			.map((e) => (e.type === "model_change" ? e.modelId : ""));

	it.each(PATHS)("%s switches the model, records one model_change, and emits model_select once", async (path) => {
		const { harness, events } = await setup();

		await switchToSecond(harness, path);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelChanges(harness)).toEqual(["faux-2"]);
		expect(events.filter((e) => e.startsWith("select"))).toEqual([
			`select faux-1->faux-2:${path === "setModel" ? "set" : "cycle"}`,
		]);
	});

	it.each(PATHS)("%s saves the default model only when asked to persist", async (path) => {
		const { harness } = await setup();

		await switchToSecond(harness, path);
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();

		const back = await setup();
		await switchToSecond(back.harness, path, { persist: true });
		expect(back.harness.settingsManager.getDefaultModel()).toBe("faux-2");
		expect(back.harness.settingsManager.getDefaultProvider()).toBe(back.harness.getModel("faux-2")?.provider);
	});

	it.each(PATHS)("%s has saved the default model by the time model_select fires", async (path) => {
		const { harness, defaultAtSelect } = await setup();

		await switchToSecond(harness, path, { persist: true });

		expect(defaultAtSelect).toEqual(["faux-2"]);
	});

	it.each(PATHS)("%s applies the new model's own thinking level, clamped, before model_select fires", async (path) => {
		const { harness, events } = await setup();
		const second = harness.getModel("faux-2") as Model<string>;
		harness.settingsManager.setModelThinkingLevel(second.provider, second.id, "low");
		harness.session.setThinkingLevel("high");
		events.length = 0;

		await switchToSecond(harness, path);

		expect(harness.session.thinkingLevel).toBe("low");
		expect(events).toEqual(["level low", `select faux-1->faux-2:${path === "setModel" ? "set" : "cycle"}`]);
	});

	it.each(["scopedCycle", "availableCycle"] as const)(
		"%s reports the new model, its level and whether the cycle was scoped",
		async (path) => {
			const { harness } = await setup();

			const result = await switchToSecond(harness, path);

			expect(result).toMatchObject({ isScoped: path === "scopedCycle" });
			expect(result?.model.id).toBe("faux-2");
			expect(result?.thinkingLevel).toBe(harness.session.thinkingLevel);
		},
	);

	it("a scoped model's explicit thinking level beats the defaults", async () => {
		const { harness } = await setup();
		harness.session.setScopedModels([
			{ model: harness.getModel("faux-1") as Model<string> },
			{ model: harness.getModel("faux-2") as Model<string>, thinkingLevel: "medium" as ThinkingLevel },
		]);

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("medium");
	});

	it("setModel to the model already in use emits no model_select", async () => {
		const { harness, events } = await setup();

		await harness.session.setModel(harness.getModel("faux-1") as Model<string>);

		expect(events.filter((e) => e.startsWith("select"))).toEqual([]);
	});
});
