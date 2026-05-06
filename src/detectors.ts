import type { DetectionConfig, DetectionResult, ParsedEpisode, SegmentDecision, Transcript } from "./types.js";

export function detectAdSegments(episode: ParsedEpisode, transcript: Transcript | undefined, config: DetectionConfig): DetectionResult {
  const untimedSignals = detectUntimedSignals(episode, config);
  return {
    decisions: [],
    untimedSignals
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

function detectUntimedSignals(episode: ParsedEpisode, config: DetectionConfig): string[] {
  const haystack = [episode.description, episode.title, episode.chapters.map((chapter) => chapter.title).join(" ")].join("\n").toLowerCase();
  const signals = new Set<string>();
  if (/\b(use|enter)\s+(code|promo code|discount code)\b/.test(haystack)) signals.add("Metadata mentions promo/code language");
  if (/\b(sponsor(ed)?|brought to you by|partner(ed)? with)\b/.test(haystack)) signals.add("Metadata mentions sponsorship language");
  if (/\b(discount|free trial|exclusive deal|exclusive offer|money back guarantee)\b/.test(haystack)) signals.add("Metadata mentions offer language");
  if (/\b(gamble responsibly|terms and conditions|support is available|privacy information)\b/.test(haystack)) signals.add("Metadata contains legal/ad disclosure language");
  if (/https?:\/\/|www\./.test(haystack)) signals.add("Metadata contains outbound links");
  for (const phrase of config.dynamicAdMarkerPhrases) {
    if (phrase && haystack.includes(phrase.toLowerCase())) signals.add(`Metadata mentions dynamic ad marker: ${phrase}`);
  }
  return Array.from(signals);
}
