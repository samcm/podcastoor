import type { Chapter, SegmentDecision, TranscriptSegment } from "./types.js";

export interface Segment {
  start: number;
  end: number;
}

export function removalSegments(decisions: SegmentDecision[], confidenceThreshold: number): Segment[] {
  return decisions
    .filter((decision) => decision.action === "remove" && decision.confidence >= confidenceThreshold)
    .map((decision) => ({ start: decision.start, end: decision.end }));
}

export function normalizeSegments(
  segments: Segment[],
  options: {
    durationSeconds?: number;
    paddingSeconds?: number;
    prePaddingSeconds?: number;
    postPaddingSeconds?: number;
    minSegmentSeconds?: number;
    maxSegmentSeconds?: number;
  } = {}
): Segment[] {
  const prePadding = options.prePaddingSeconds ?? options.paddingSeconds ?? 0;
  const postPadding = options.postPaddingSeconds ?? options.paddingSeconds ?? 0;
  const duration = options.durationSeconds;
  const sorted = segments
    .map((segment) => {
      const start = Math.max(0, segment.start - prePadding);
      const end = duration == null ? segment.end + postPadding : Math.min(duration, segment.end + postPadding);
      return { start, end };
    })
    .filter((segment) => segment.end > segment.start)
    .filter((segment) => {
      const length = segment.end - segment.start;
      return length >= (options.minSegmentSeconds ?? 0) && length <= (options.maxSegmentSeconds ?? Number.POSITIVE_INFINITY);
    })
    .sort((a, b) => a.start - b.start);

  const merged: Segment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 0.25) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function snapOpeningCutToContent(
  segments: Segment[],
  transcriptSegments: TranscriptSegment[],
  options: { durationSeconds?: number; openingSnapSeconds?: number; maxGapSeconds?: number } = {}
): Segment[] {
  if (segments.length === 0) return [];
  const openingSnapSeconds = options.openingSnapSeconds ?? 1;
  const maxGapSeconds = options.maxGapSeconds ?? 5;
  const out = segments.map((segment) => ({ ...segment }));
  const first = out[0];

  if (first.start <= openingSnapSeconds) {
    first.start = 0;
    const firstPostAdSpeech = transcriptSegments.find((segment) => segment.start >= first.end - 0.05);
    if (firstPostAdSpeech) {
      const gapSeconds = firstPostAdSpeech.start - first.end;
      if (gapSeconds >= -0.05 && gapSeconds <= maxGapSeconds) {
        first.end = Math.max(first.end, firstPostAdSpeech.start);
      }
    }
  }

  return normalizeSegments(out, { durationSeconds: options.durationSeconds });
}

export function durationAfterEdits(durationSeconds: number | undefined, removed: Segment[], jingleDurationSeconds: number): number | undefined {
  if (durationSeconds == null) return undefined;
  const removedSeconds = removed.reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
  const markerSeconds = removed.reduce((total, segment) => total + markerDurationForCut(segment, jingleDurationSeconds, durationSeconds), 0);
  return Math.max(0, durationSeconds - removedSeconds + markerSeconds);
}

export function mapOriginalToProcessed(timeSeconds: number, removed: Segment[], jingleDurationSeconds: number, sourceDurationSeconds?: number): number {
  let mapped = Math.max(0, timeSeconds);
  for (const segment of removed) {
    if (timeSeconds < segment.start) break;
    const removedLength = segment.end - segment.start;
    const markerDuration = markerDurationForCut(segment, jingleDurationSeconds, sourceDurationSeconds);
    if (timeSeconds <= segment.end) {
      return Math.max(0, segment.start - removedBefore(segment.start, removed, jingleDurationSeconds, sourceDurationSeconds));
    }
    mapped -= removedLength;
    mapped += markerDuration;
  }
  return Math.max(0, mapped);
}

function markerDurationForCut(segment: Segment, jingleDurationSeconds: number, sourceDurationSeconds?: number): number {
  if (jingleDurationSeconds <= 0) return 0;
  if (sourceDurationSeconds != null && (segment.start <= 0.05 || segment.end >= sourceDurationSeconds - 0.05)) return 0;
  return jingleDurationSeconds;
}

function removedBefore(timeSeconds: number, removed: Segment[], jingleDurationSeconds: number, sourceDurationSeconds?: number): number {
  return removed
    .filter((segment) => segment.end <= timeSeconds)
    .reduce((total, segment) => total + (segment.end - segment.start) - markerDurationForCut(segment, jingleDurationSeconds, sourceDurationSeconds), 0);
}

export function remapChapters(chapters: Chapter[], removed: Segment[], jingleDurationSeconds: number, sourceDurationSeconds?: number): Chapter[] {
  const remapped = chapters
    .filter((chapter) => !removed.some((segment) => chapter.startTime > segment.start && chapter.startTime < segment.end))
    .map((chapter) => ({
      ...chapter,
      startTime: mapOriginalToProcessed(chapter.startTime, removed, jingleDurationSeconds, sourceDurationSeconds)
    }))
    .sort((a, b) => a.startTime - b.startTime);

  if (remapped.length > 0 && remapped[0].startTime > 0.5) {
    remapped.unshift({ startTime: 0, title: "Start" });
  }
  return dedupeChapterStarts(remapped);
}

function dedupeChapterStarts(chapters: Chapter[]): Chapter[] {
  const out: Chapter[] = [];
  for (const chapter of chapters) {
    const previous = out.at(-1);
    if (previous && Math.abs(previous.startTime - chapter.startTime) < 0.5) {
      previous.title = previous.title === "Start" ? chapter.title : previous.title;
      continue;
    }
    out.push({ ...chapter, startTime: Math.max(0, Number(chapter.startTime.toFixed(3))) });
  }
  return out;
}

export function keepSegments(durationSeconds: number, removed: Segment[]): Segment[] {
  const keeps: Segment[] = [];
  let cursor = 0;
  for (const segment of removed) {
    if (segment.start > cursor) {
      keeps.push({ start: cursor, end: segment.start });
    }
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < durationSeconds) {
    keeps.push({ start: cursor, end: durationSeconds });
  }
  return keeps.filter((segment) => segment.end - segment.start > 0.05);
}
