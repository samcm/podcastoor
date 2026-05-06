import { expect, test } from "vitest";
import { alignTranscript } from "../src/alignment.js";

test("segment-boundary alignment removes overlapping transcript timings", () => {
  const result = alignTranscript(
    { enabled: true, provider: "segment-boundary", model: "segment-boundary-v1" },
    {
      source: "fixture",
      format: "json",
      text: "hello world",
      segments: [
        { start: 0, end: 5, text: "hello" },
        { start: 4, end: 8, text: "world" }
      ]
    }
  );

  expect(result.transcript.segments[0].end).toBeLessThanOrEqual(result.transcript.segments[1].start);
  expect(result.metadata?.adjustedSegments).toBeGreaterThan(0);
  expect(result.metadata?.provider).toBe("segment-boundary");
});
