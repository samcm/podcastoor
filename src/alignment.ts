import type { AlignmentConfig, Transcript, TranscriptSegment } from "./types.js";

export interface AlignmentResult {
  transcript: Transcript;
  metadata?: {
    provider: string;
    model: string;
    confidence: number;
    adjustedSegments: number;
    averageAdjustmentSeconds: number;
    maxAdjustmentSeconds: number;
    notes: string[];
  };
}

export function alignTranscript(config: AlignmentConfig, transcript: Transcript | undefined): AlignmentResult {
  if (!transcript || !config.enabled || config.provider === "none" || transcript.segments.length === 0) {
    return { transcript: transcript ?? emptyTranscript() };
  }

  const alignedSegments: TranscriptSegment[] = [];
  const adjustments: number[] = [];
  for (const [index, segment] of transcript.segments.entries()) {
    const previous = alignedSegments.at(-1);
    const next = transcript.segments[index + 1];
    const start = previous ? Math.max(segment.start, previous.end) : Math.max(0, segment.start);
    const naturalEnd = Math.max(start + 0.05, segment.end);
    const nextStart = next ? Math.max(start + 0.05, next.start) : naturalEnd;
    const end = next && naturalEnd > nextStart ? Math.max(start + 0.05, nextStart) : naturalEnd;
    const aligned = {
      ...segment,
      start: roundMillis(start),
      end: roundMillis(end)
    };
    alignedSegments.push(aligned);
    adjustments.push(Math.abs(aligned.start - segment.start), Math.abs(aligned.end - segment.end));
  }

  const adjustedSegments = alignedSegments.filter((segment, index) => {
    const original = transcript.segments[index];
    return Math.abs(segment.start - original.start) > 0.001 || Math.abs(segment.end - original.end) > 0.001;
  }).length;
  const maxAdjustmentSeconds = adjustments.length ? Math.max(...adjustments) : 0;
  const averageAdjustmentSeconds = adjustments.length ? adjustments.reduce((sum, value) => sum + value, 0) / adjustments.length : 0;

  return {
    transcript: {
      ...transcript,
      segments: alignedSegments
    },
    metadata: {
      provider: config.provider,
      model: config.model,
      confidence: maxAdjustmentSeconds > 1 ? 0.65 : 0.85,
      adjustedSegments,
      averageAdjustmentSeconds: roundMillis(averageAdjustmentSeconds),
      maxAdjustmentSeconds: roundMillis(maxAdjustmentSeconds),
      notes: [
        "Segment-boundary alignment removes overlaps and impossible segment ordering.",
        "This is an isolated alignment stage; it is not a word-level forced aligner."
      ]
    }
  };
}

function emptyTranscript(): Transcript {
  return { source: "none", format: "none", text: "", segments: [] };
}

function roundMillis(value: number): number {
  return Number(value.toFixed(3));
}
