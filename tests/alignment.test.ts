import { expect, test } from "vitest";
import { alignTranscript, applyWordAlignment, refineDecisionsWithAlignedWords } from "../src/alignment.js";

test("segment-boundary alignment removes overlapping transcript timings", async () => {
  const result = await alignTranscript(
    { enabled: true, provider: "segment-boundary", model: "segment-boundary-v1", estimatedCostPerMinuteUsd: 0, requireProvider: false },
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

test("word alignment remaps segments and refines decision boundaries", () => {
  const config = { enabled: true, provider: "elevenlabs-forced", model: "elevenlabs-forced-alignment", estimatedCostPerMinuteUsd: 0.003667, requireProvider: false } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "real words sponsored offer",
    segments: [
      { start: 0, end: 5, text: "real words" },
      { start: 5, end: 10, text: "sponsored offer" }
    ]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "real", start: 0.2, end: 0.5 },
    { text: "words", start: 0.7, end: 1 },
    { text: "sponsored", start: 6.2, end: 6.8 },
    { text: "offer", start: 7, end: 7.4 }
  ]);

  expect(aligned.transcript.segments[1]).toMatchObject({ start: 6.2, end: 7.4 });
  expect(aligned.transcript.words).toHaveLength(4);

  const refined = refineDecisionsWithAlignedWords(
    [
      {
        start: 5,
        end: 10,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: { startSegmentIndex: 1, endSegmentIndex: 1, method: "model-timestamp" }
      }
    ],
    aligned.transcript
  );

  expect(refined.adjustedDecisions).toBe(1);
  expect(refined.decisions[0]).toMatchObject({ start: 6.2, end: 7.4, alignment: { method: "forced-word" } });
});
