import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AlignedWord, AlignmentConfig, SegmentDecision, Transcript, TranscriptSegment } from "./types.js";
import { stripHtml } from "./utils.js";

const execFileAsync = promisify(execFile);

export interface AlignmentResult {
  transcript: Transcript;
  metadata?: {
    provider: string;
    model: string;
    confidence: number;
    adjustedSegments: number;
    averageAdjustmentSeconds: number;
    maxAdjustmentSeconds: number;
    wordCount?: number;
    seconds?: number;
    costUsd?: number;
    notes: string[];
  };
}

export interface DecisionRefinementResult {
  decisions: SegmentDecision[];
  adjustedDecisions: number;
}

export function alignmentWillUseHostedProvider(config: AlignmentConfig): boolean {
  if (!config.enabled) return false;
  if (config.provider === "elevenlabs-forced") return true;
  return config.provider === "auto" && Boolean(process.env.ELEVENLABS_API_KEY);
}

export async function alignTranscript(
  config: AlignmentConfig,
  transcript: Transcript | undefined,
  options: { sourceAudioPath?: string; durationSeconds?: number } = {}
): Promise<AlignmentResult> {
  if (!transcript || !config.enabled || config.provider === "none" || transcript.segments.length === 0) {
    return { transcript: transcript ?? emptyTranscript() };
  }

  const provider = resolveAlignmentProvider(config, options.sourceAudioPath);
  if (provider === "elevenlabs-forced") {
    if (!options.sourceAudioPath) {
      if (config.requireProvider) throw new Error("ElevenLabs forced alignment requires source audio");
      return segmentBoundaryAlign(config, transcript, ["ElevenLabs forced alignment skipped because source audio is unavailable."]);
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      if (config.requireProvider) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs forced alignment");
      return segmentBoundaryAlign(config, transcript, ["ElevenLabs forced alignment skipped because ELEVENLABS_API_KEY is not set."]);
    }
    try {
      return await alignWithElevenLabs(config, transcript, options.sourceAudioPath, options.durationSeconds, apiKey);
    } catch (error) {
      if (config.requireProvider) throw error;
      return segmentBoundaryAlign(config, transcript, [`ElevenLabs forced alignment failed; fell back to segment-boundary alignment: ${String(error)}`]);
    }
  }

  return segmentBoundaryAlign(config, transcript);
}

export function refineDecisionsWithAlignedWords(decisions: SegmentDecision[], transcript: Transcript): DecisionRefinementResult {
  if (!transcript.words?.length) return { decisions, adjustedDecisions: 0 };
  let adjustedDecisions = 0;
  const refined = decisions.map((decision) => {
    if (decision.action !== "remove") return decision;
    const words = wordsForDecision(decision, transcript.words ?? []);
    if (words.length === 0) return decision;
    const startWord = words.find((word) => word.end >= decision.start - 0.15) ?? words[0];
    const endWord = [...words].reverse().find((word) => word.start <= decision.end + 0.15) ?? words.at(-1);
    if (!startWord || !endWord) return decision;
    const start = roundMillis(Math.max(0, startWord.start));
    const end = roundMillis(Math.max(start + 0.05, endWord.end));
    if (end <= start || (Math.abs(start - decision.start) < 0.001 && Math.abs(end - decision.end) < 0.001)) return decision;
    adjustedDecisions += 1;
    return {
      ...decision,
      start,
      end,
      alignment: {
        startSegmentIndex: decision.alignment?.startSegmentIndex ?? startWord.segmentIndex,
        endSegmentIndex: decision.alignment?.endSegmentIndex ?? endWord.segmentIndex,
        method: "forced-word"
      },
      text: overlappingText(transcript.segments, start, end)
    } satisfies SegmentDecision;
  });
  return { decisions: refined, adjustedDecisions };
}

export function applyWordAlignment(
  config: AlignmentConfig,
  transcript: Transcript,
  words: AlignedWord[],
  details: { provider: string; model: string; durationSeconds?: number; costUsd?: number; notes?: string[] } = {
    provider: "test",
    model: "test"
  }
): AlignmentResult {
  if (words.length === 0) return segmentBoundaryAlign(config, transcript, details.notes);

  const alignedWords = words
    .map((word) => ({
      ...word,
      text: stripHtml(word.text).trim(),
      start: roundMillis(Math.max(0, word.start)),
      end: roundMillis(Math.max(word.start, word.end))
    }))
    .filter((word) => word.text && word.end > word.start)
    .sort((a, b) => a.start - b.start);
  if (alignedWords.length === 0) return segmentBoundaryAlign(config, transcript, details.notes);

  const alignedSegments: TranscriptSegment[] = [];
  const globalWords: AlignedWord[] = [];
  let cursor = 0;
  for (const [index, segment] of transcript.segments.entries()) {
    const tokenCount = Math.max(1, tokenize(segment.text).length);
    const isLast = index === transcript.segments.length - 1;
    const segmentWords = alignedWords.slice(cursor, isLast ? alignedWords.length : Math.min(alignedWords.length, cursor + tokenCount));
    cursor += tokenCount;
    if (segmentWords.length === 0) {
      alignedSegments.push(segment);
      continue;
    }
    const wordsWithSegment = segmentWords.map((word) => ({ ...word, segmentIndex: index }));
    globalWords.push(...wordsWithSegment);
    alignedSegments.push({
      ...segment,
      start: wordsWithSegment[0].start,
      end: wordsWithSegment.at(-1)?.end ?? wordsWithSegment[0].end,
      words: wordsWithSegment
    });
  }

  const normalized = normalizeSegmentOrder(alignedSegments);
  const adjustments = segmentAdjustments(transcript.segments, normalized);
  const adjustedSegments = adjustments.filter((adjustment) => adjustment > 0.001).length;
  const maxAdjustmentSeconds = adjustments.length ? Math.max(...adjustments) : 0;
  const averageAdjustmentSeconds = adjustments.length ? adjustments.reduce((sum, value) => sum + value, 0) / adjustments.length : 0;
  const averageLoss = average(globalWords.map((word) => word.loss).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));

  return {
    transcript: {
      ...transcript,
      source: `${transcript.source}+alignment:${details.provider}`,
      segments: normalized,
      words: globalWords
    },
    metadata: {
      provider: details.provider,
      model: details.model,
      confidence: lossToConfidence(averageLoss),
      adjustedSegments,
      averageAdjustmentSeconds: roundMillis(averageAdjustmentSeconds),
      maxAdjustmentSeconds: roundMillis(maxAdjustmentSeconds),
      wordCount: globalWords.length,
      seconds: details.durationSeconds,
      costUsd: details.costUsd,
      notes: [
        "Forced alignment produced provider word-level timestamps and remapped transcript segment boundaries.",
        ...(details.notes ?? [])
      ]
    }
  };
}

async function alignWithElevenLabs(
  config: AlignmentConfig,
  transcript: Transcript,
  sourceAudioPath: string,
  fallbackDurationSeconds: number | undefined,
  apiKey: string
): Promise<AlignmentResult> {
  const durationSeconds = await probeDuration(sourceAudioPath, fallbackDurationSeconds);
  const text = (transcript.text || transcript.segments.map((segment) => segment.text).join(" ")).trim();
  if (!text) return segmentBoundaryAlign(config, transcript, ["ElevenLabs forced alignment skipped because transcript text is empty."]);

  const response = await postElevenLabsForcedAlignment(apiKey, sourceAudioPath, text);
  const words = (response.words ?? [])
    .map((word) => ({
      text: String(word.text ?? ""),
      start: Number(word.start),
      end: Number(word.end),
      loss: typeof word.loss === "number" ? word.loss : undefined
    }))
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const costUsd = Number(((durationSeconds / 60) * config.estimatedCostPerMinuteUsd).toFixed(6));
  return applyWordAlignment(config, transcript, words, {
    provider: "elevenlabs-forced",
    model: config.model,
    durationSeconds,
    costUsd,
    notes: [
      `ElevenLabs response loss=${typeof response.loss === "number" ? response.loss.toFixed(4) : "unknown"}.`,
      "Cost is estimated from configured per-minute alignment pricing because the API response does not include per-request cost."
    ]
  });
}

async function postElevenLabsForcedAlignment(
  apiKey: string,
  sourceAudioPath: string,
  text: string
): Promise<{ words?: Array<{ text?: string; start?: number; end?: number; loss?: number }>; loss?: number }> {
  const audio = await readFile(sourceAudioPath);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const form = new FormData();
    form.set("file", new Blob([audio]), "episode.mp3");
    form.set("text", text);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 360_000);
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/forced-alignment", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal
      });
      const body = await response.text();
      if (response.ok) return JSON.parse(body) as { words?: Array<{ text?: string; start?: number; end?: number; loss?: number }>; loss?: number };
      lastError = `${response.status} ${body.slice(0, 500)}`;
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
  }
  throw new Error(`ElevenLabs forced alignment failed after retries: ${lastError}`);
}

function resolveAlignmentProvider(config: AlignmentConfig, sourceAudioPath: string | undefined): "elevenlabs-forced" | "segment-boundary" {
  if (config.provider === "elevenlabs-forced") return "elevenlabs-forced";
  if (config.provider === "auto" && sourceAudioPath && process.env.ELEVENLABS_API_KEY) return "elevenlabs-forced";
  return "segment-boundary";
}

function segmentBoundaryAlign(config: AlignmentConfig, transcript: Transcript, extraNotes: string[] = []): AlignmentResult {
  const alignedSegments = normalizeSegmentOrder(transcript.segments);
  const adjustments = segmentAdjustments(transcript.segments, alignedSegments);
  const adjustedSegments = adjustments.filter((adjustment) => adjustment > 0.001).length;
  const maxAdjustmentSeconds = adjustments.length ? Math.max(...adjustments) : 0;
  const averageAdjustmentSeconds = adjustments.length ? adjustments.reduce((sum, value) => sum + value, 0) / adjustments.length : 0;

  return {
    transcript: {
      ...transcript,
      segments: alignedSegments
    },
    metadata: {
      provider: config.provider === "auto" ? "segment-boundary" : config.provider,
      model: config.provider === "auto" ? "segment-boundary-v1" : config.model,
      confidence: maxAdjustmentSeconds > 1 ? 0.65 : 0.85,
      adjustedSegments,
      averageAdjustmentSeconds: roundMillis(averageAdjustmentSeconds),
      maxAdjustmentSeconds: roundMillis(maxAdjustmentSeconds),
      notes: [
        "Segment-boundary alignment removes overlaps and impossible segment ordering.",
        "This is not word-level forced alignment; configure ELEVENLABS_API_KEY or provider=elevenlabs-forced to enable hosted forced alignment.",
        ...extraNotes
      ]
    }
  };
}

function normalizeSegmentOrder(segments: TranscriptSegment[]): TranscriptSegment[] {
  const alignedSegments: TranscriptSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const previous = alignedSegments.at(-1);
    const next = segments[index + 1];
    const start = previous ? Math.max(segment.start, previous.end) : Math.max(0, segment.start);
    const naturalEnd = Math.max(start + 0.05, segment.end);
    const nextStart = next ? Math.max(start + 0.05, next.start) : naturalEnd;
    const end = next && naturalEnd > nextStart ? Math.max(start + 0.05, nextStart) : naturalEnd;
    alignedSegments.push({
      ...segment,
      start: roundMillis(start),
      end: roundMillis(end)
    });
  }
  return alignedSegments;
}

function segmentAdjustments(original: TranscriptSegment[], aligned: TranscriptSegment[]): number[] {
  return aligned.flatMap((segment, index) => {
    const source = original[index];
    if (!source) return [];
    return [Math.abs(segment.start - source.start), Math.abs(segment.end - source.end)];
  });
}

function wordsForDecision(decision: SegmentDecision, words: AlignedWord[]): AlignedWord[] {
  const startIndex = decision.alignment?.startSegmentIndex;
  const endIndex = decision.alignment?.endSegmentIndex;
  return words.filter((word) => {
    const inSegmentRange =
      startIndex == null ||
      endIndex == null ||
      word.segmentIndex == null ||
      (word.segmentIndex >= Math.min(startIndex, endIndex) && word.segmentIndex <= Math.max(startIndex, endIndex));
    return inSegmentRange && word.end >= decision.start - 2 && word.start <= decision.end + 2;
  });
}

function overlappingText(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => segment.text)
    .join(" ")
    .slice(0, 1200);
}

async function probeDuration(filePath: string, fallback?: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    const duration = Number(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {
    // Fall through to fallback duration.
  }
  if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
  throw new Error(`Could not determine duration for ${filePath}`);
}

function emptyTranscript(): Transcript {
  return { source: "none", format: "none", text: "", segments: [] };
}

function tokenize(value: string): string[] {
  return stripHtml(value)
    .toLowerCase()
    .match(/[a-z0-9']+/g) ?? [];
}

function lossToConfidence(loss: number | undefined): number {
  if (loss == null || !Number.isFinite(loss)) return 0.9;
  return Number(Math.max(0, Math.min(1, 1 / (1 + Math.max(0, loss)))).toFixed(3));
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMillis(value: number): number {
  return Number(value.toFixed(3));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
