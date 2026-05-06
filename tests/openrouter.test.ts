import { describe, expect, it } from "vitest";
import { parsedAdSegmentToDecision } from "../src/openrouter.js";
import type { Transcript } from "../src/types.js";

const transcript: Transcript = {
  source: "openrouter-audio-chat:test",
  format: "json",
  text: "Commercial intro. Editorial resumes.",
  segments: [
    { start: 0, end: 10, text: "Commercial intro." },
    { start: 10, end: 20, text: "Still commercial." },
    { start: 20, end: 30, text: "Editorial resumes." }
  ]
};

describe("openrouter ad parsing", () => {
  it("prefers absolute model timestamps over segment boundaries", () => {
    const decision = parsedAdSegmentToDecision(
      {
        startTime: 2.25,
        endTime: 18.75,
        startSegment: 0,
        endSegment: 2,
        action: "remove",
        confidence: 0.93,
        reason: "commercial read",
        advertiser: "Example Brand"
      },
      transcript
    );

    expect(decision).toMatchObject({
      start: 2.25,
      end: 18.75,
      action: "remove",
      confidence: 0.93,
      advertiser: "Example Brand",
      alignment: {
        startSegmentIndex: 0,
        endSegmentIndex: 1,
        method: "model-timestamp"
      }
    });
  });

  it("accepts older segment offsets, including accidental absolute offset values", () => {
    const decision = parsedAdSegmentToDecision(
      {
        startSegment: 0,
        endSegment: 1,
        startOffsetSeconds: 0,
        endOffsetSeconds: 18.75,
        action: "remove",
        confidence: 0.9
      },
      transcript
    );

    expect(decision?.start).toBe(0);
    expect(decision?.end).toBe(18.75);
  });
});
