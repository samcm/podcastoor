import { describe, expect, it } from "vitest";
import { durationAfterEdits, mapOriginalToProcessed, normalizeSegments, remapChapters } from "../src/timeline.js";

describe("timeline", () => {
  it("merges removals and remaps chapters after cuts plus jingle markers", () => {
    const removed = normalizeSegments(
      [
        { start: 10, end: 20 },
        { start: 20.1, end: 30 }
      ],
      { durationSeconds: 100, paddingSeconds: 0, minSegmentSeconds: 1 }
    );

    expect(removed).toEqual([{ start: 10, end: 30 }]);
    expect(durationAfterEdits(100, removed, 0.5)).toBe(80.5);
    expect(mapOriginalToProcessed(40, removed, 0.5)).toBe(20.5);

    const chapters = remapChapters(
      [
        { startTime: 0, title: "Start" },
        { startTime: 15, title: "Ad" },
        { startTime: 40, title: "Main Topic" }
      ],
      removed,
      0.5
    );
    expect(chapters).toEqual([
      { startTime: 0, title: "Start" },
      { startTime: 20.5, title: "Main Topic" }
    ]);
  });

  it("supports asymmetric cut padding so starts can stay exact while tails are softened", () => {
    const removed = normalizeSegments([{ start: 30, end: 40 }], {
      durationSeconds: 60,
      paddingSeconds: 5,
      prePaddingSeconds: 0,
      postPaddingSeconds: 1.5,
      minSegmentSeconds: 1
    });

    expect(removed).toEqual([{ start: 30, end: 41.5 }]);
    expect(mapOriginalToProcessed(45, removed, 0)).toBe(33.5);
  });
});
