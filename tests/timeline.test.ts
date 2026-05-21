import { describe, expect, it } from "vitest";
import { durationAfterEdits, mapOriginalToProcessed, normalizeSegments, remapChapters, snapOpeningCutToContent } from "../src/timeline.js";

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

  it("snaps opening ad cuts to zero and folds short pre-content gaps into the cut", () => {
    const removed = snapOpeningCutToContent(
      [{ start: 0.419, end: 14.819 }],
      [
        { start: 0.419, end: 4.519, text: "In the beginning, there was 4X." },
        { start: 12.679, end: 16.459, text: "The weekend, made for 4X." },
        { start: 16.579, end: 20.719, text: "The sizzling sausage. Studs on cement." }
      ],
      { durationSeconds: 100 }
    );

    expect(removed).toEqual([{ start: 0, end: 16.579 }]);
    expect(mapOriginalToProcessed(16.579, removed, 0.35, 100)).toBe(0);
    expect(Number(mapOriginalToProcessed(21, removed, 0.35, 100).toFixed(3))).toBe(4.421);
    expect(durationAfterEdits(100, removed, 0.35)).toBeCloseTo(83.421);
  });
});
