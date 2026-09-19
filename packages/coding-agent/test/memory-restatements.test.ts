import { describe, expect, it } from "vitest";
import { areLikelyRestatements } from "../src/core/memory-dedup.ts";

describe("areLikelyRestatements", () => {
	it("matches the same fact in different words (real production pairs)", () => {
		expect(
			areLikelyRestatements(
				"The user is abah (Hafiz), creator of Theoses",
				"Hafiz is the creator of Theoses and should be addressed as 'abah'",
			),
		).toBe(true);
		expect(
			areLikelyRestatements(
				"Per-row write calls during the catalogue ingest timed out, so writes were switched to chunked batches over one MCP session",
				"The catalogue-ingestion pipeline writes in chunked batches over a single MCP session because per-row write calls timed out",
			),
		).toBe(true);
	});

	it("matches identical text after normalising case and punctuation", () => {
		expect(areLikelyRestatements("Deploy to /var/www!", "deploy to var www")).toBe(true);
	});

	it("does not match a different fact that shares a topic", () => {
		expect(
			areLikelyRestatements(
				"The portfolio site is served by Caddy from apps/web/dist",
				"The user prefers the orange portfolio variant over the other candidates",
			),
		).toBe(false);
	});

	it("never matches when the numbers differ", () => {
		expect(
			areLikelyRestatements(
				"API port 8085 is allocated for the portfolio backend",
				"API port 8082 is allocated for the portfolio backend",
			),
		).toBe(false);
	});

	it("never matches when one of them negates", () => {
		expect(
			areLikelyRestatements(
				"The explorer agent uses the free model for exploration tasks",
				"The explorer agent does not use the free model for exploration tasks",
			),
		).toBe(false);
	});

	it("does not match short subjects that share only a couple of words", () => {
		expect(areLikelyRestatements("Deploy the site", "Deploy the site now")).toBe(false);
	});

	it("respects a stricter overlap threshold", () => {
		const a = "The user is abah (Hafiz), creator of Theoses";
		const b = "Hafiz is the creator of Theoses and should be addressed as 'abah'";
		expect(areLikelyRestatements(a, b, 0.5)).toBe(true);
		expect(areLikelyRestatements(a, b, 0.9)).toBe(false);
	});
});
