import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AlignedWord, AlignmentConfig, SegmentDecision, Transcript, TranscriptSegment } from "./types.js";
import { stripHtml } from "./utils.js";

const execFileAsync = promisify(execFile);
type ResolvedAlignmentProvider = "whisperx-local" | "elevenlabs-forced" | "segment-boundary";

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

export interface TransitionExpansionResult {
  decisions: SegmentDecision[];
  expandedDecisions: number;
}

export interface ContentLossGuardResult {
  decisions: SegmentDecision[];
  guardedBoundaries: number;
  downgradedDecisions: number;
}

export interface EndingAdExtensionResult {
  decisions: SegmentDecision[];
  extendedDecisions: number;
}

export interface TargetedAlignmentWindow {
  id: number;
  start: number;
  end: number;
  text: string;
  decisionIndexes: number[];
}

export function alignmentWillUseHostedProvider(config: AlignmentConfig): boolean {
  return config.enabled && (config.provider === "elevenlabs-forced" || config.provider === "elevenlabs-targeted");
}

export function alignmentNeedsSourceAudio(config: AlignmentConfig): boolean {
  if (!config.enabled) return false;
  if (config.provider === "none" || config.provider === "segment-boundary") return false;
  return true;
}

export function alignmentUsesTargetedProvider(config: AlignmentConfig): boolean {
  return config.enabled && config.provider === "elevenlabs-targeted";
}

export async function alignTranscript(
  config: AlignmentConfig,
  transcript: Transcript | undefined,
  options: { sourceAudioPath?: string; durationSeconds?: number } = {}
): Promise<AlignmentResult> {
  if (!config.enabled || config.provider === "none") {
    return { transcript: transcript ?? emptyTranscript() };
  }
  if (!transcript || transcript.segments.length === 0) {
    throw new Error("Forced alignment requires a non-empty transcript");
  }

  const provider = resolveAlignmentProvider(config);
  if (transcriptHasReusableWordAlignment(transcript, provider)) {
    return {
      transcript,
      metadata: {
        provider,
        model: config.model,
        confidence: reusableWordConfidence(transcript.words ?? []),
        adjustedSegments: 0,
        averageAdjustmentSeconds: 0,
        maxAdjustmentSeconds: 0,
        wordCount: transcript.words?.length,
        seconds: options.durationSeconds,
        costUsd: 0,
        notes: ["Reused existing word-level forced alignment from transcript artifacts."]
      }
    };
  }

  if (provider === "whisperx-local") {
    if (!options.sourceAudioPath) {
      throw new Error("WhisperX forced alignment requires source audio");
    }
    if (process.env.WHISPERX_ALIGN_ENABLED === "false") {
      throw new Error("WhisperX forced alignment is required but WHISPERX_ALIGN_ENABLED=false");
    }
    return await alignWithWhisperX(config, transcript, options.sourceAudioPath, options.durationSeconds);
  }

  if (provider === "elevenlabs-forced") {
    if (!options.sourceAudioPath) {
      throw new Error("ElevenLabs forced alignment requires source audio");
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs forced alignment");
    }
    return await alignWithElevenLabs(config, transcript, options.sourceAudioPath, options.durationSeconds, apiKey);
  }

  return segmentBoundaryAlign(config, transcript);
}

export async function alignTargetedDecisionWindows(
  config: AlignmentConfig,
  transcript: Transcript,
  decisions: SegmentDecision[],
  options: { sourceAudioPath?: string; durationSeconds?: number; confidenceThreshold?: number } = {}
): Promise<AlignmentResult> {
  if (!alignmentUsesTargetedProvider(config)) return { transcript };
  const windows = targetedAlignmentWindowsForDecisions(transcript, decisions, config, {
    durationSeconds: options.durationSeconds,
    confidenceThreshold: options.confidenceThreshold
  });
  if (windows.length === 0) return { transcript };
  if (!options.sourceAudioPath) throw new Error("ElevenLabs targeted alignment requires source audio");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs targeted alignment");

  const workDir = await mkdtemp(path.join(tmpdir(), "podcastoor-elevenlabs-targeted-"));
  const allWords: AlignedWord[] = [];
  let totalSeconds = 0;
  const notes: string[] = [];
  try {
    for (const window of windows) {
      const clipPath = path.join(workDir, `window-${window.id}.wav`);
      const duration = Math.max(0.05, window.end - window.start);
      totalSeconds += duration;
      await extractAudioClip(options.sourceAudioPath, clipPath, window.start, duration);
      const response = await postElevenLabsForcedAlignment(apiKey, clipPath, window.text);
      const windowWords = (response.words ?? [])
        .map((word) => {
          const start = Number(word.start) + window.start;
          const end = Number(word.end) + window.start;
          return {
            text: String(word.text ?? ""),
            start,
            end,
            loss: typeof word.loss === "number" ? word.loss : undefined,
            segmentIndex: segmentIndexAtTime(transcript.segments, start)
          } satisfies AlignedWord;
        })
        .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
      if (windowWords.length === 0) throw new Error(`ElevenLabs targeted alignment returned no word timestamps for window ${window.id}`);
      allWords.push(...windowWords);
      notes.push(
        `Aligned candidate window ${window.id + 1}/${windows.length}: ${window.start.toFixed(2)}-${window.end.toFixed(2)}s, words=${windowWords.length}, loss=${
          typeof response.loss === "number" ? response.loss.toFixed(4) : "unknown"
        }.`
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const dedupedWords = dedupeAlignedWords(allWords);
  const costUsd = Number(((totalSeconds / 60) * config.estimatedCostPerMinuteUsd).toFixed(6));
  return applyWordAlignment(config, transcript, dedupedWords, {
    provider: "elevenlabs-targeted",
    model: config.model,
    durationSeconds: totalSeconds,
    costUsd,
    notes: [
      `Targeted alignment processed ${windows.length} candidate windows (${(totalSeconds / 60).toFixed(2)} min), not the full episode.`,
      "Cost is estimated from configured per-minute alignment pricing because the API response does not include per-request cost.",
      ...notes
    ]
  });
}

export function targetedAlignmentWindowsForDecisions(
  transcript: Transcript,
  decisions: SegmentDecision[],
  config: AlignmentConfig,
  options: { durationSeconds?: number; confidenceThreshold?: number } = {}
): TargetedAlignmentWindow[] {
  if (!config.enabled || config.provider !== "elevenlabs-targeted") return [];
  const threshold = options.confidenceThreshold ?? 0;
  const durationSeconds = Math.max(
    0,
    options.durationSeconds ?? 0,
    transcript.segments.at(-1)?.end ?? 0,
    ...decisions.map((decision) => decision.end)
  );
  const maxWindows = Math.max(1, Math.floor(config.targetMaxWindows || 1));
  const contextSeconds = Math.max(0, config.targetContextSeconds || 0);
  const maxClipSeconds = Math.max(0, config.targetMaxClipSeconds || 0);
  const rawWindows = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action === "remove" && decision.confidence >= threshold && decision.end > decision.start)
    .map(({ decision, index }) => {
      const decisionDuration = decision.end - decision.start;
      const effectiveContext =
        maxClipSeconds > 0 && decisionDuration + contextSeconds * 2 > maxClipSeconds
          ? Math.max(0, (maxClipSeconds - decisionDuration) / 2)
          : contextSeconds;
      return {
        start: Math.max(0, decision.start - effectiveContext),
        end: durationSeconds > 0 ? Math.min(durationSeconds, decision.end + effectiveContext) : decision.end + effectiveContext,
        decisionIndexes: [index]
      };
    })
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number; decisionIndexes: number[] }> = [];
  for (const window of rawWindows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, window.end);
      previous.decisionIndexes.push(...window.decisionIndexes);
    } else {
      merged.push({ ...window });
    }
  }

  return merged.slice(0, maxWindows).map((window, id) => ({
    id,
    start: roundMillis(window.start),
    end: roundMillis(Math.max(window.start + 0.05, window.end)),
    decisionIndexes: window.decisionIndexes,
    text: transcriptTextForWindow(transcript, window.start, window.end)
  })).filter((window) => window.text.length > 0);
}

export function refineDecisionsWithAlignedWords(decisions: SegmentDecision[], transcript: Transcript): DecisionRefinementResult {
  if (!transcript.words?.length) return { decisions, adjustedDecisions: 0 };
  let adjustedDecisions = 0;
  const allWords = transcript.words ?? [];
  const refined = decisions.map((decision) => {
    if (decision.action !== "remove") return decision;
    const words = wordsForDecision(decision, allWords);
    if (words.length === 0) return decision;
    const startAnchor =
      findAnchorWords(decision.alignment?.startAnchorText, words) ??
      findBestAnchorWords(decision.alignment?.startAnchorText, allWords, "first", decision.start);
    const endAnchor =
      findAnchorWords(decision.alignment?.endAnchorText, words, "last") ??
      findBestAnchorWords(decision.alignment?.endAnchorText, allWords, "last", decision.end);
    const startWord = startAnchor?.[0] ?? words.find((word) => word.end >= decision.start - 0.15) ?? words[0];
    const endWord = endAnchor?.at(-1) ?? [...words].reverse().find((word) => word.start <= decision.end + 0.15) ?? words.at(-1);
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
        startSegmentIndex: startWord.segmentIndex,
        endSegmentIndex: endWord.segmentIndex,
        method: "forced-word",
        startAnchorText: decision.alignment?.startAnchorText,
        endAnchorText: decision.alignment?.endAnchorText
      },
      text: overlappingText(transcript.segments, start, end)
    } satisfies SegmentDecision;
  });
  return { decisions: refined, adjustedDecisions };
}

export function expandDecisionsAcrossNonSpeechTransitions(
  decisions: SegmentDecision[],
  transcript: Transcript,
  options: { maxTransitionSeconds?: number; toleranceSeconds?: number } = {}
): TransitionExpansionResult {
  const maxTransitionSeconds = options.maxTransitionSeconds ?? 8;
  const toleranceSeconds = options.toleranceSeconds ?? 0.6;
  let expandedDecisions = 0;
  const expanded = decisions.map((decision) => {
    if (decision.action !== "remove") return decision;
    let start = decision.start;
    let end = decision.end;
    const previous = [...transcript.segments].reverse().find((segment) => segment.end <= start + toleranceSeconds);
    if (previous && isNonSpeechTransition(previous) && start - previous.start <= maxTransitionSeconds) {
      start = Math.min(start, previous.start);
    }
    const next = transcript.segments.find((segment) => segment.start >= end - toleranceSeconds);
    if (next && isNonSpeechTransition(next) && next.end - end <= maxTransitionSeconds) {
      end = Math.max(end, next.end);
    }
    if (Math.abs(start - decision.start) < 0.001 && Math.abs(end - decision.end) < 0.001) return decision;
    expandedDecisions += 1;
    return {
      ...decision,
      start: roundMillis(start),
      end: roundMillis(end),
      text: overlappingText(transcript.segments, start, end)
    } satisfies SegmentDecision;
  });
  return { decisions: expanded, expandedDecisions };
}

export function guardDecisionsAgainstContentLoss(
  decisions: SegmentDecision[],
  transcript: Transcript,
  options: { toleranceSeconds?: number } = {}
): ContentLossGuardResult {
  const toleranceSeconds = options.toleranceSeconds ?? 0.25;
  if (decisions.some((decision) => decision.action === "remove") && !transcript.words?.length) {
    throw new Error("Refusing destructive ad cuts without word-level alignment");
  }

  let guardedBoundaries = 0;
  let downgradedDecisions = 0;
  const guarded = decisions.map((decision) => {
    if (decision.action !== "remove") return decision;

    let start = decision.start;
    let end = decision.end;
    const startSegmentIndex = decision.alignment?.startSegmentIndex ?? segmentIndexAtTime(transcript.segments, decision.start);
    const endSegmentIndex = decision.alignment?.endSegmentIndex ?? segmentIndexAtTime(transcript.segments, Math.max(decision.start, decision.end - 0.001));
    const startSegment = transcript.segments[startSegmentIndex];
    const endSegment = transcript.segments[endSegmentIndex];
    const startAnchorMatched = boundaryAnchorMatched(decision.alignment?.startAnchorText, transcript.words ?? [], "start", decision.start, toleranceSeconds);
    const endAnchorMatched = boundaryAnchorMatched(decision.alignment?.endAnchorText, transcript.words ?? [], "end", decision.end, toleranceSeconds);

    if (startSegment && boundaryInsideSegment(start, startSegment, toleranceSeconds) && !startAnchorMatched) {
      start = startSegment.end;
      guardedBoundaries += 1;
    }
    if (endSegment && boundaryInsideSegment(end, endSegment, toleranceSeconds) && !endAnchorMatched) {
      end = endSegment.start;
      guardedBoundaries += 1;
    }

    start = roundMillis(Math.max(0, start));
    end = roundMillis(Math.max(0, end));
    if (end <= start + toleranceSeconds) {
      downgradedDecisions += 1;
      return {
        ...decision,
        action: "mark-only",
        confidence: Math.min(decision.confidence, 0.5),
        reason: `${decision.reason}; unsafe boundary`,
        text: overlappingText(transcript.segments, decision.start, decision.end)
      } satisfies SegmentDecision;
    }

    if (Math.abs(start - decision.start) < 0.001 && Math.abs(end - decision.end) < 0.001) return decision;
    return {
      ...decision,
      start,
      end,
      reason: `${decision.reason}; content guard`,
      alignment: {
        ...decision.alignment,
        startSegmentIndex,
        endSegmentIndex,
        method: decision.alignment?.method ?? "forced-word"
      },
      text: overlappingText(transcript.segments, start, end)
    } satisfies SegmentDecision;
  });

  return { decisions: guarded, guardedBoundaries, downgradedDecisions };
}

export function extendEndingAdDecisions(
  decisions: SegmentDecision[],
  transcript: Transcript,
  options: { finalWindowSeconds?: number; minimumExtensionSeconds?: number } = {}
): EndingAdExtensionResult {
  const transcriptEnd = transcript.segments.at(-1)?.end ?? 0;
  if (transcriptEnd <= 0) return { decisions, extendedDecisions: 0 };

  const finalWindowSeconds = options.finalWindowSeconds ?? 20;
  const minimumExtensionSeconds = options.minimumExtensionSeconds ?? 3;
  let extendedDecisions = 0;
  const extended = decisions.map((decision) => {
    if (decision.action !== "remove" || decision.confidence < 0.85) return decision;
    const startsInFinalWindow = decision.start >= transcriptEnd - finalWindowSeconds;
    const meaningfulExtension = transcriptEnd - decision.end >= minimumExtensionSeconds;
    if (!startsInFinalWindow || !meaningfulExtension) return decision;
    extendedDecisions += 1;
    return {
      ...decision,
      end: roundMillis(transcriptEnd),
      reason: appendDecisionReason(decision.reason, "ending ad tail"),
      alignment: {
        ...decision.alignment,
        endSegmentIndex: Math.max(0, transcript.segments.length - 1),
        method: decision.alignment?.method ?? "forced-word"
      },
      text: overlappingText(transcript.segments, decision.start, transcriptEnd)
    } satisfies SegmentDecision;
  });

  return { decisions: extended, extendedDecisions };
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
  if (words.length === 0) {
    if (config.provider === "segment-boundary") return segmentBoundaryAlign(config, transcript, details.notes);
    throw new Error(`${details.provider} alignment returned no word timestamps`);
  }

  const alignedWords = words
    .map((word) => ({
      ...word,
      text: stripHtml(word.text).trim(),
      start: roundMillis(Math.max(0, word.start)),
      end: roundMillis(Math.max(word.start, word.end))
    }))
    .filter((word) => word.text && word.end > word.start)
    .sort((a, b) => a.start - b.start);
  if (alignedWords.length === 0) {
    if (config.provider === "segment-boundary") return segmentBoundaryAlign(config, transcript, details.notes);
    throw new Error(`${details.provider} alignment returned no usable word timestamps`);
  }

  const alignedSegments: TranscriptSegment[] = [];
  const globalWords: AlignedWord[] = [];
  let cursor = 0;
  const wordsBySegment = alignedWords.reduce((map, word) => {
    if (word.segmentIndex != null && Number.isInteger(word.segmentIndex) && word.segmentIndex >= 0) {
      const existing = map.get(word.segmentIndex) ?? [];
      existing.push(word);
      map.set(word.segmentIndex, existing);
    }
    return map;
  }, new Map<number, AlignedWord[]>());
  const useProviderSegmentIndexes = wordsBySegment.size > 0;
  for (const [index, segment] of transcript.segments.entries()) {
    const segmentWords = useProviderSegmentIndexes
      ? (wordsBySegment.get(index) ?? [])
      : (() => {
          const tokenCount = Math.max(1, tokenize(segment.text).length);
          const isLast = index === transcript.segments.length - 1;
          const wordsForTokenWindow = alignedWords.slice(cursor, isLast ? alignedWords.length : Math.min(alignedWords.length, cursor + tokenCount));
          cursor += tokenCount;
          return wordsForTokenWindow;
        })();
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
  const averageConfidence = average(globalWords.map((word) => word.confidence).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));

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
      confidence: averageConfidence != null ? Number(Math.max(0, Math.min(1, averageConfidence)).toFixed(3)) : lossToConfidence(averageLoss),
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

async function alignWithWhisperX(
  config: AlignmentConfig,
  transcript: Transcript,
  sourceAudioPath: string,
  fallbackDurationSeconds: number | undefined
): Promise<AlignmentResult> {
  const durationSeconds = await probeDuration(sourceAudioPath, fallbackDurationSeconds);
  const segments = transcript.segments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: stripHtml(segment.text).trim()
    }))
    .filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
  if (segments.length === 0) throw new Error("WhisperX forced alignment requires non-empty transcript segments");

  const workDir = await mkdtemp(path.join(tmpdir(), "podcastoor-whisperx-"));
  const inputPath = path.join(workDir, "transcript.json");
  const outputPath = path.join(workDir, "alignment.json");
  try {
    await writeFile(inputPath, JSON.stringify({ language: transcript.language ?? "en", segments }, null, 2));
    const python = process.env.WHISPERX_PYTHON ?? "python3";
    const scriptPath = process.env.WHISPERX_ALIGN_SCRIPT ?? path.join(process.cwd(), "scripts", "whisperx_align.py");
    const args = [
      scriptPath,
      "--audio",
      sourceAudioPath,
      "--transcript-json",
      inputPath,
      "--output",
      outputPath,
      "--language",
      transcript.language ?? "en",
      "--device",
      process.env.WHISPERX_DEVICE ?? "cpu"
    ];
    const alignModel = whisperXAlignModel(config);
    if (alignModel) args.push("--align-model", alignModel);
    await execFileAsync(python, args, {
      timeout: Number(process.env.WHISPERX_ALIGN_TIMEOUT_MS ?? 1_800_000),
      maxBuffer: 10 * 1024 * 1024
    });
    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      provider?: string;
      model?: string;
      words?: Array<{ text?: string; start?: number; end?: number; confidence?: number; segmentIndex?: number }>;
      notes?: string[];
    };
    const words = (payload.words ?? [])
      .map((word) => ({
        text: String(word.text ?? ""),
        start: Number(word.start),
        end: Number(word.end),
        confidence: typeof word.confidence === "number" ? word.confidence : undefined,
        segmentIndex: typeof word.segmentIndex === "number" ? word.segmentIndex : undefined
      }))
      .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    return applyWordAlignment(config, transcript, words, {
      provider: "whisperx-local",
      model: payload.model ?? alignModel ?? config.model,
      durationSeconds,
      notes: [
        "WhisperX ran locally, so no hosted alignment API cost was recorded.",
        ...(payload.notes ?? [])
      ]
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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
  if (words.length === 0) throw new Error("ElevenLabs forced alignment returned no word timestamps");
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
  const maxAttempts = elevenLabsAlignmentMaxAttempts();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const form = new FormData();
    form.set("file", new Blob([audio]), path.basename(sourceAudioPath));
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
      break;
    } finally {
      clearTimeout(timeout);
    }
    await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
  }
  throw new Error(`ElevenLabs forced alignment failed after retries: ${lastError}`);
}

function elevenLabsAlignmentMaxAttempts(): number {
  const configured = Number(process.env.ELEVENLABS_ALIGNMENT_MAX_ATTEMPTS);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(3, Math.floor(configured));
  return 1;
}

async function extractAudioClip(sourceAudioPath: string, outputPath: string, startSeconds: number, durationSeconds: number): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      startSeconds.toFixed(3),
      "-t",
      durationSeconds.toFixed(3),
      "-i",
      sourceAudioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-acodec",
      "pcm_s16le",
      outputPath
    ],
    { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }
  );
}

function dedupeAlignedWords(words: AlignedWord[]): AlignedWord[] {
  const seen = new Set<string>();
  const deduped: AlignedWord[] = [];
  for (const word of words.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const key = `${word.text.toLowerCase()}@${word.start.toFixed(2)}-${word.end.toFixed(2)}:${word.segmentIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(word);
  }
  return deduped;
}

function transcriptTextForWindow(transcript: Transcript, start: number, end: number): string {
  return transcript.segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => stripHtml(segment.text).trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveAlignmentProvider(config: AlignmentConfig): ResolvedAlignmentProvider {
  if (config.provider === "whisperx-local") return "whisperx-local";
  if (config.provider === "elevenlabs-forced") return "elevenlabs-forced";
  if (config.provider === "auto") return "whisperx-local";
  return "segment-boundary";
}

function whisperXAlignModel(config: AlignmentConfig): string | undefined {
  const normalized = config.model.trim();
  if (!normalized || normalized === "whisperx" || normalized === "whisperx-default") return undefined;
  if (normalized.startsWith("whisperx:")) return normalized.slice("whisperx:".length);
  if (config.provider === "auto") return undefined;
  return normalized;
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
        "This is not word-level forced alignment; configure provider=whisperx-local for local forced alignment or provider=elevenlabs-forced for hosted forced alignment.",
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
  const hasSegmentRange = startIndex != null && endIndex != null;
  const hasAnchorText = Boolean(decision.alignment?.startAnchorText || decision.alignment?.endAnchorText);
  return words.filter((word) => {
    const inSegmentRange =
      !hasSegmentRange ||
      word.segmentIndex == null ||
      (word.segmentIndex >= Math.min(startIndex, endIndex) && word.segmentIndex <= Math.max(startIndex, endIndex));
    if (!inSegmentRange) return false;
    if (hasSegmentRange && hasAnchorText) return true;
    return word.end >= decision.start - 2 && word.start <= decision.end + 2;
  });
}

function segmentIndexAtTime(segments: TranscriptSegment[], time: number): number {
  for (const [index, segment] of segments.entries()) {
    if (time >= segment.start - 0.001 && time <= segment.end + 0.001) return index;
    if (time < segment.start) return Math.max(0, index - 1);
  }
  return Math.max(0, segments.length - 1);
}

function transcriptHasReusableWordAlignment(transcript: Transcript, provider: ResolvedAlignmentProvider): boolean {
  if (provider === "segment-boundary") return false;
  return transcript.source.includes(`+alignment:${provider}`) && (transcript.words?.length ?? 0) > 0;
}

function reusableWordConfidence(words: AlignedWord[]): number {
  const confidences = words.map((word) => word.confidence).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (confidences.length === 0) return 0.9;
  return Number(Math.max(0, Math.min(1, confidences.reduce((sum, value) => sum + value, 0) / confidences.length)).toFixed(3));
}

function boundaryInsideSegment(time: number, segment: TranscriptSegment, toleranceSeconds: number): boolean {
  return time > segment.start + toleranceSeconds && time < segment.end - toleranceSeconds;
}

function boundaryAnchorMatched(
  anchorText: string | undefined,
  words: AlignedWord[],
  boundary: "start" | "end",
  time: number,
  toleranceSeconds: number
): boolean {
  const anchorWords = findAnchorWords(anchorText, words, boundary === "end" ? "last" : "first");
  if (!anchorWords?.length) return false;
  const anchorTime = boundary === "start" ? anchorWords[0].start : (anchorWords.at(-1)?.end ?? anchorWords[0].end);
  return Math.abs(anchorTime - time) <= Math.max(toleranceSeconds, 0.35);
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

function appendDecisionReason(existing: string, addition: string): string {
  const base = existing.replace(/\s+/g, " ").trim();
  const extra = addition.replace(/\s+/g, " ").trim();
  if (!base) return extra.slice(0, 120);
  if (!extra || base.toLowerCase().includes(extra.toLowerCase())) return base.slice(0, 120);
  return `${base}; ${extra}`.slice(0, 120);
}

function tokenize(value: string): string[] {
  return stripHtml(value)
    .toLowerCase()
    .match(/[a-z0-9']+/g) ?? [];
}

function findAnchorWords(anchorText: string | undefined, words: AlignedWord[], occurrence: "first" | "last" = "first"): AlignedWord[] | undefined {
  const matches = findAnchorWordMatches(anchorText, words);
  if (matches.length === 0) return undefined;
  return occurrence === "last" ? matches.at(-1) : matches[0];
}

function findBestAnchorWords(
  anchorText: string | undefined,
  words: AlignedWord[],
  occurrence: "first" | "last",
  targetTime: number
): AlignedWord[] | undefined {
  const matches = findAnchorWordMatches(anchorText, words);
  if (matches.length === 0) return undefined;
  return matches
    .map((match) => ({
      match,
      distance: Math.abs((occurrence === "last" ? (match.at(-1)?.end ?? match[0].end) : match[0].start) - targetTime)
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.match;
}

function findAnchorWordMatches(anchorText: string | undefined, words: AlignedWord[]): AlignedWord[][] {
  const anchorTokens = tokenize(anchorText ?? "");
  if (anchorTokens.length === 0) return [];
  const wordTokens = words.map((word) => tokenize(word.text)[0] ?? "");
  const matches: AlignedWord[][] = [];
  for (let index = 0; index <= wordTokens.length - anchorTokens.length; index += 1) {
    const candidate = wordTokens.slice(index, index + anchorTokens.length);
    if (candidate.every((token, offset) => token === anchorTokens[offset])) {
      matches.push(words.slice(index, index + anchorTokens.length));
    }
  }
  return matches;
}

function isNonSpeechTransition(segment: TranscriptSegment): boolean {
  const text = stripHtml(segment.text).trim();
  return /^\[(music|theme|jingle|silence|pause|sound|sfx|applause|intro|outro)\]$/i.test(text);
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
