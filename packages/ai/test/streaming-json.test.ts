import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/json-parse.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/json-parse.ts")>();
	return {
		...actual,
		parseStreamingJson: vi.fn(actual.parseStreamingJson),
		parseCompleteJson: vi.fn(actual.parseCompleteJson),
	};
});

describe("StreamingJsonAccumulator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("parses a live preview on the first delta", async () => {
		const { StreamingJsonAccumulator } = await import("../src/utils/streaming-json.ts");
		const { parseStreamingJson } = await import("../src/utils/json-parse.ts");

		const accumulator = new StreamingJsonAccumulator();
		const preview = accumulator.append('{"path":"a.txt"');

		expect(preview).toEqual({ path: "a.txt" });
		expect(vi.mocked(parseStreamingJson)).toHaveBeenCalledTimes(1);
	});

	it("throttles re-parses for a large argument streamed in small deltas (O(n/2000), not O(n))", async () => {
		const { StreamingJsonAccumulator, STREAMING_ARGS_REPARSE_THROTTLE_CHARS } = await import(
			"../src/utils/streaming-json.ts"
		);
		const { parseStreamingJson } = await import("../src/utils/json-parse.ts");

		const body = "x".repeat(200_000);
		const fullArgs = `{"path":"a.txt","content":"${body}"}`;
		const deltaChunkSize = 10;
		const deltas: string[] = [];
		for (let i = 0; i < fullArgs.length; i += deltaChunkSize) {
			deltas.push(fullArgs.slice(i, i + deltaChunkSize));
		}
		expect(deltas.length).toBeGreaterThan(1000);

		const accumulator = new StreamingJsonAccumulator();
		for (const delta of deltas) {
			accumulator.append(delta);
		}

		// One parse on the very first delta, then roughly one per throttle window.
		const expectedMaxCalls = Math.ceil(fullArgs.length / STREAMING_ARGS_REPARSE_THROTTLE_CHARS) + 2;
		expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(expectedMaxCalls);
		expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(deltas.length);
	});

	it("finish() with no override strictly parses the accumulated buffer", async () => {
		const { StreamingJsonAccumulator } = await import("../src/utils/streaming-json.ts");
		const { parseCompleteJson } = await import("../src/utils/json-parse.ts");

		const accumulator = new StreamingJsonAccumulator();
		accumulator.append('{"path":"a.txt"}');
		const result = accumulator.finish();

		expect(result).toEqual({ path: "a.txt" });
		expect(vi.mocked(parseCompleteJson)).toHaveBeenCalledWith('{"path":"a.txt"}');
	});

	it("finish(overrideText) replaces the buffer before the strict parse", async () => {
		const { StreamingJsonAccumulator } = await import("../src/utils/streaming-json.ts");
		const { parseCompleteJson } = await import("../src/utils/json-parse.ts");

		const accumulator = new StreamingJsonAccumulator();
		accumulator.append('{"path":"a.t');
		const result = accumulator.finish('{"path":"a.txt","content":"final"}');

		expect(result).toEqual({ path: "a.txt", content: "final" });
		expect(vi.mocked(parseCompleteJson)).toHaveBeenCalledWith('{"path":"a.txt","content":"final"}');
		expect(accumulator.buffer).toBe('{"path":"a.txt","content":"final"}');
	});

	it("preview on invalid/partial JSON behaves like parseStreamingJson (best-effort, never throws)", async () => {
		const { StreamingJsonAccumulator } = await import("../src/utils/streaming-json.ts");

		const accumulator = new StreamingJsonAccumulator();
		const preview = accumulator.append('{"path": "a.txt", "content": "unterminated');

		expect(preview).toEqual({ path: "a.txt", content: "unterminated" });
	});
});
