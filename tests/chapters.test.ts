import { expect, test } from "vitest";
import { buildChapters, normalizeChapters } from "../src/chapters.js";
import { remapChapters } from "../src/timeline.js";
import type { ParsedEpisode } from "../src/types.js";

test("publisher chapters are preserved, normalized, and remapped after cuts", () => {
  const episode: ParsedEpisode = {
    raw: {},
    key: "episode",
    guid: "episode",
    title: "Episode",
    description: "",
    durationSeconds: 600,
    transcripts: [],
    chapters: [
      { startTime: 0, title: "Discussion: Intro" },
      { startTime: 120, title: "NRL Finals Preview" },
      { startTime: 300, title: "AFL Controversy Segment" }
    ],
    sourceFingerprint: "fingerprint"
  };

  const source = buildChapters(episode, undefined, { preferred: ["NRL"], muted: ["AFL"] });
  const remapped = normalizeChapters(remapChapters(source, [{ start: 60, end: 90 }], 0.35));

  expect(source.map((chapter) => chapter.title)).toEqual(["Intro", "NRL Finals Preview", "AFL Controversy"]);
  expect(remapped[1].startTime).toBeCloseTo(90.35);
  expect(remapped.length).toBeLessThanOrEqual(10);
});
