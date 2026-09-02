import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.THEOSES_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.THEOSES_EXPERIMENTAL;
		} else {
			process.env.THEOSES_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when THEOSES_EXPERIMENTAL is unset", () => {
		delete process.env.THEOSES_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when THEOSES_EXPERIMENTAL is empty", () => {
		process.env.THEOSES_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when THEOSES_EXPERIMENTAL is set to 1", () => {
		process.env.THEOSES_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when THEOSES_EXPERIMENTAL is set to 0", () => {
		process.env.THEOSES_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when THEOSES_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.THEOSES_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
