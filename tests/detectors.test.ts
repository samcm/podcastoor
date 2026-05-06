import { describe, expect, it } from "vitest";
import { detectAdSegments } from "../src/detectors.js";
import type { DetectionConfig, ParsedEpisode, Transcript } from "../src/types.js";

const config: DetectionConfig = {
  paddingSeconds: 0.5,
  minSegmentSeconds: 5,
  maxSegmentSeconds: 120,
  adKeywords: ["sponsored by", "use code"],
  dynamicAdMarkerPhrases: ["advertisement"]
};

describe("detectors", () => {
  it("keeps transcript keywords as model context only and emits untimed metadata signals", () => {
    const episode = {
      title: "Episode",
      description: "Use code TEST at checkout.",
      chapters: [],
      transcripts: [],
      key: "episode",
      guid: "episode",
      sourceFingerprint: "x",
      raw: {}
    } satisfies ParsedEpisode;
    const transcript: Transcript = {
      source: "test",
      format: "text/vtt",
      text: "This episode is sponsored by a product. Back to the show.",
      segments: [
        { start: 30, end: 42, text: "This episode is sponsored by a product." },
        { start: 42, end: 50, text: "Back to the show." }
      ]
    };

    const result = detectAdSegments(episode, transcript, config);
    expect(result.decisions).toEqual([]);
    expect(result.untimedSignals).toContain("Metadata mentions promo/code language");
  });
});
