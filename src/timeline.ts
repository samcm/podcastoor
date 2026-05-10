import type { Chapter, SegmentDecision } from "./types.js";

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

export function durationAfterEdits(durationSeconds: number | undefined, removed: Segment[], jingleDurationSeconds: number): number | undefined {
  if (durationSeconds == null) return undefined;
  const removedSeconds = removed.reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
  return Math.max(0, durationSeconds - removedSeconds + removed.length * jingleDurationSeconds);
}

export function mapOriginalToProcessed(timeSeconds: number, removed: Segment[], jingleDurationSeconds: number): number {
  let mapped = Math.max(0, timeSeconds);
  for (const segment of removed) {
    if (timeSeconds < segment.start) break;
    const removedLength = segment.end - segment.start;
    if (timeSeconds <= segment.end) {
      return Math.max(0, segment.start - removedBefore(segment.start, removed, jingleDurationSeconds));
    }
    mapped -= removedLength;
    mapped += jingleDurationSeconds;
  }
  return Math.max(0, mapped);
}

function removedBefore(timeSeconds: number, removed: Segment[], jingleDurationSeconds: number): number {
  return removed
    .filter((segment) => segment.end <= timeSeconds)
    .reduce((total, segment) => total + (segment.end - segment.start) - jingleDurationSeconds, 0);
}

export function remapChapters(chapters: Chapter[], removed: Segment[], jingleDurationSeconds: number): Chapter[] {
  const remapped = chapters
    .filter((chapter) => !removed.some((segment) => chapter.startTime > segment.start && chapter.startTime < segment.end))
    .map((chapter) => ({
      ...chapter,
      startTime: mapOriginalToProcessed(chapter.startTime, removed, jingleDurationSeconds)
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
