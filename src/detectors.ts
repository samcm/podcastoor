import type { DetectionConfig, DetectionResult, ParsedEpisode, SegmentDecision, Transcript } from "./types.js";

export function detectAdSegments(episode: ParsedEpisode, transcript: Transcript | undefined, config: DetectionConfig): DetectionResult {
  void episode;
  void transcript;
  void config;
  return {
    decisions: [],
    untimedSignals: []
  };
}

export function dedupeSegmentDecisions(decisions: SegmentDecision[]): SegmentDecision[] {
  const sorted = [...decisions].sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start));
  const kept: SegmentDecision[] = [];
  for (const decision of sorted) {
    const duplicate = kept.some(
      (existing) =>
        existing.action === decision.action &&
        Math.abs(existing.start - decision.start) < 1 &&
        Math.abs(existing.end - decision.end) < 1
    );
    const contained = kept.some(
      (existing) =>
        existing.action === decision.action &&
        existing.confidence >= decision.confidence &&
        existing.start <= decision.start + 0.5 &&
        existing.end >= decision.end - 0.5
    );
    if (!duplicate && !contained) kept.push(decision);
  }
  return kept.sort((a, b) => a.start - b.start);
}
