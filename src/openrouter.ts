import type { Chapter, DetectionResult, EffectivePodcastConfig, LlmConfig, LlmUsage, ParsedEpisode, SegmentDecision, Transcript, TranscriptSegment } from "./types.js";

interface TextLlmJsonResult {
  content: string;
  usage?: LlmUsage;
}

type TextLlmProvider = Exclude<LlmConfig["provider"], "none">;

const CLASSIFIER_WINDOW_SECONDS = 300;
const CLASSIFIER_OVERLAP_SECONDS = 20;
const EDGE_AUDIT_SECONDS = 180;
const AD_BLOCK_BRIDGE_SECONDS = 20;
const TEXT_LLM_MAX_ATTEMPTS = 3;
const CLASSIFIER_SPLIT_MIN_SEGMENTS = 30;
const CLASSIFIER_SPLIT_MAX_DEPTH = 2;

type ParsedAdSegment = {
  startTime?: number;
  endTime?: number;
  startSegment?: number;
  endSegment?: number;
  startAnchorText?: string;
  endAnchorText?: string;
  action?: "remove" | "keep" | "mark-only";
  confidence?: number;
  reason?: string;
  advertiser?: string;
  startOffsetSeconds?: number;
  endOffsetSeconds?: number;
};

type ParsedClassification = {
  adSegments?: ParsedAdSegment[];
};

type ParsedCutReview = {
  reviews?: ParsedCutReviewEntry[];
};

type ParsedCutReviewEntry = {
  id?: number;
  action?: "remove" | "keep" | "mark-only";
  confidence?: number;
  reason?: string;
  advertiser?: string;
  startTime?: number;
  endTime?: number;
  startAnchorText?: string;
  endAnchorText?: string;
};

type ParsedBoundaryReview = {
  reviews?: ParsedBoundaryReviewEntry[];
};

type ParsedBoundaryReviewEntry = ParsedCutReviewEntry & {
  startWord?: number;
  endWord?: number;
};

interface CutReviewCandidateRecord {
  id: number;
  proposedStart: number;
  proposedEnd: number;
  proposedDuration: number;
  proposedReason: string;
  proposedAdvertiser?: string;
  proposedText?: string;
  context: Array<{ start: number; end: number; cut: "before" | "inside" | "after" | "overlap"; text: string }>;
}

interface BoundaryReviewCandidateRecord {
  id: number;
  proposedStart: number;
  proposedEnd: number;
  proposedDuration: number;
  proposedReason: string;
  proposedAdvertiser?: string;
  segments: Array<{ i: number; start: number; end: number; cut: "before" | "inside" | "after" | "overlap"; text: string }>;
  words: Array<{ w: number; start: number; end: number; text: string; segment?: number }>;
}

const CUT_REVIEW_CONTEXT_SECONDS = 50;
const CUT_REVIEW_BATCH_CHAR_TARGET = 80_000;
const BOUNDARY_REVIEW_CONTEXT_SECONDS = 35;
const BOUNDARY_REVIEW_BATCH_CHAR_TARGET = 70_000;

export async function generateChaptersWithTextLlm(podcast: EffectivePodcastConfig, transcript: Transcript): Promise<{ chapters: Chapter[]; usage?: LlmUsage }> {
  const client = textLlmClient(podcast.llm);
  if (!client) return { chapters: [] };

  const prompt = buildChapterPrompt(podcast, transcript);
  const result = await postTextLlmJson(client, "chapter-generation", {
    messages: [
      {
        role: "system",
        content:
          "You create useful podcast topic chapters from timestamped transcripts. Return strict JSON only: {\"chapters\":[{\"startTime\":number,\"title\":string}]}. Return at most 10 chapters."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 1400,
    response_format: { type: "json_object" }
  });
  const parsed = JSON.parse(result.content || "{\"chapters\":[]}") as { chapters?: Chapter[] };
  const chapters = normalizeModelChapters(
    (parsed.chapters ?? [])
    .filter((chapter) => typeof chapter.startTime === "number" && chapter.title)
      .map((chapter) => ({ startTime: chapter.startTime, title: chapter.title.slice(0, 120) }))
  );
  return { chapters, usage: result.usage };
}

export async function classifyTranscriptWithTextLlm(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  transcript: Transcript
): Promise<DetectionResult> {
  const client = textLlmClient(podcast.llm);
  if (!client || transcript.segments.length === 0) {
    return { decisions: [], untimedSignals: [], modelNotes: [] };
  }

  const upstreamChapters = episode.chapters.map((chapter) => ({
    startTime: Number(chapter.startTime.toFixed(2)),
    title: chapter.title.slice(0, 120)
  }));

  const usage: LlmUsage[] = [];
  const parsedWindows: ParsedClassification[] = [];
  const windows = buildTranscriptWindows(transcript);
  const notes: string[] = [];
  const fatalNotes: string[] = [];

  for (const [windowIndex, windowSegments] of windows.entries()) {
    try {
      logClassifierWindow(client.provider, "started", windowIndex, windows.length, windowSegments);
      const prompt = buildClassifierPrompt(podcast, episode, windowSegments, upstreamChapters, windowIndex, windows.length);
      const result = await postTextLlmJson(client, "ad-detection", classifierBody(prompt, podcast.llm.maxTranscriptChars));
      if (result.usage) usage.push(result.usage);
      const parsed = parseJsonObject(result.content || "{}") as ParsedClassification;
      parsedWindows.push(parsed);
      logClassifierWindow(client.provider, "complete", windowIndex, windows.length, windowSegments, {
        decisions: parsed.adSegments?.length ?? 0,
        costUsd: result.usage?.costUsd
      });
    } catch (error) {
      if (isFatalTextLlmError(error)) {
        throw new Error(`${client.label} ad detection failed for window ${windowIndex + 1}/${windows.length}: ${String(error)}`);
      }
      if (shouldSplitClassificationError(error, windowSegments, 0)) {
        try {
          const splitResult = await classifySplitWindow(client, podcast, episode, windowSegments, upstreamChapters, windowIndex, windows.length, podcast.llm.maxTranscriptChars, 1);
          usage.push(...splitResult.usage);
          parsedWindows.push(...splitResult.parsed);
          continue;
        } catch (splitError) {
          fatalNotes.push(`Window ${windowIndex + 1}/${windows.length} classification failed after split: ${String(splitError)}`);
          logClassifierWindow(client.provider, "failed", windowIndex, windows.length, windowSegments, { error: String(splitError), split: true });
          if (isFatalTextLlmError(splitError)) {
            throw new Error(`${client.label} ad detection failed for window ${windowIndex + 1}/${windows.length}: ${String(splitError)}`);
          }
          continue;
        }
      }
      fatalNotes.push(`Window ${windowIndex + 1}/${windows.length} classification failed: ${String(error)}`);
      logClassifierWindow(client.provider, "failed", windowIndex, windows.length, windowSegments, { error: String(error) });
    }
  }

  const edgeWindows = buildEdgeAuditWindows(transcript);
  for (const [edgeIndex, edgeWindow] of edgeWindows.entries()) {
    try {
      logClassifierWindow(client.provider, "started", windows.length + edgeIndex, windows.length + edgeWindows.length, edgeWindow.segments, { edge: edgeWindow.label });
      const prompt = buildEdgeAuditPrompt(podcast, episode, edgeWindow.segments, edgeWindow.label);
      const result = await postTextLlmJson(client, "ad-detection", classifierBody(prompt, podcast.llm.maxTranscriptChars));
      if (result.usage) usage.push(result.usage);
      const parsed = parseJsonObject(result.content || "{}") as ParsedClassification;
      parsedWindows.push(parsed);
      logClassifierWindow(client.provider, "complete", windows.length + edgeIndex, windows.length + edgeWindows.length, edgeWindow.segments, {
        edge: edgeWindow.label,
        decisions: parsed.adSegments?.length ?? 0,
        costUsd: result.usage?.costUsd
      });
    } catch (error) {
      if (isFatalTextLlmError(error)) {
        throw new Error(`${client.label} ad detection failed for ${edgeWindow.label} edge audit: ${String(error)}`);
      }
      if (shouldSplitClassificationError(error, edgeWindow.segments, 0)) {
        try {
          const splitResult = await classifySplitEdgeWindow(client, podcast, episode, edgeWindow.segments, edgeWindow.label, windows.length + edgeIndex, windows.length + edgeWindows.length, podcast.llm.maxTranscriptChars, 1);
          usage.push(...splitResult.usage);
          parsedWindows.push(...splitResult.parsed);
          continue;
        } catch (splitError) {
          notes.push(`${edgeWindow.label} edge audit skipped after split failure: ${String(splitError)}`);
          logClassifierWindow(client.provider, "failed", windows.length + edgeIndex, windows.length + edgeWindows.length, edgeWindow.segments, {
            edge: edgeWindow.label,
            split: true,
            error: String(splitError)
          });
          if (isFatalTextLlmError(splitError)) {
            throw new Error(`${client.label} ad detection failed for ${edgeWindow.label} edge audit: ${String(splitError)}`);
          }
          continue;
        }
      }
      notes.push(`${edgeWindow.label} edge audit skipped: ${String(error)}`);
      logClassifierWindow(client.provider, "failed", windows.length + edgeIndex, windows.length + edgeWindows.length, edgeWindow.segments, { edge: edgeWindow.label, error: String(error) });
    }
  }

  if (fatalNotes.length > 0) {
    throw new Error(`${client.label} ad detection failed for ${fatalNotes.length}/${windows.length} transcript windows: ${fatalNotes.slice(0, 3).join(" | ")}`);
  }

  const candidateDecisions = coalesceModelAdBlocks(
    parsedWindows
      .flatMap((parsed) => parsed.adSegments ?? [])
      .map((entry) => parsedAdSegmentToDecision(entry, transcript))
      .filter((entry): entry is SegmentDecision => Boolean(entry)),
    transcript.segments
  );
  const reviewed = await reviewCandidateCutsWithTextLlm(client, podcast, episode, transcript, candidateDecisions, podcast.llm.maxTranscriptChars);
  const endingExtended = extendEndingCommercialCuts(reviewed.decisions, transcript);
  usage.push(...reviewed.usage);
  notes.push(...reviewed.notes);
  if (endingExtended.extendedDecisions > 0) {
    notes.push(`Extended ${endingExtended.extendedDecisions} approved ending ad cuts to the final transcript boundary.`);
  }

  return {
    decisions: endingExtended.decisions,
    untimedSignals: [],
    modelNotes: notes,
    chapters: [],
    llmUsage: usage
  };
}

export async function reviewAlignedCutBoundariesWithTextLlm(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  transcript: Transcript,
  decisions: SegmentDecision[]
): Promise<{ decisions: SegmentDecision[]; llmUsage: LlmUsage[]; notes: string[] }> {
  const client = textLlmClient(podcast.llm);
  const removable = decisions.map((decision, id) => ({ decision, id })).filter(({ decision }) => decision.action === "remove" && decision.confidence >= 0.65);
  if (!client || removable.length === 0) return { decisions, llmUsage: [], notes: [] };
  if (!transcript.words?.length) {
    return {
      decisions,
      llmUsage: [],
      notes: ["Skipped aligned boundary review because no word-level alignment was available."]
    };
  }

  const usage: LlmUsage[] = [];
  const reviews = new Map<number, ParsedBoundaryReviewEntry>();
  for (const batch of buildBoundaryReviewBatches(removable, transcript, podcast.llm.maxTranscriptChars)) {
    const prompt = buildBoundaryReviewPrompt(podcast, episode, batch);
    const result = await postTextLlmJson(client, "boundary-review", boundaryReviewBody(prompt, podcast.llm.maxTranscriptChars));
    if (result.usage) usage.push(result.usage);
    const parsed = parseJsonObject(result.content || "{}") as ParsedBoundaryReview;
    for (const review of parsed.reviews ?? []) {
      const id = numberOrUndefined(review.id);
      if (id != null && removable.some((candidate) => candidate.id === id)) reviews.set(id, review);
    }
  }

  let adjusted = 0;
  let downgraded = 0;
  let missing = 0;
  const reviewedDecisions = decisions.map((decision, id) => {
    if (decision.action !== "remove") return decision;
    const review = reviews.get(id);
    if (!review) {
      missing += 1;
      downgraded += 1;
      return downgradeUnsafeCut(decision, "aligned boundary review missing");
    }
    const candidate = buildBoundaryReviewCandidate(id, decision, transcript);
    const applied = applyBoundaryReview(decision, review, candidate, transcript);
    if (applied.action !== "remove") downgraded += 1;
    if (Math.abs(applied.start - decision.start) > 0.001 || Math.abs(applied.end - decision.end) > 0.001) adjusted += 1;
    return applied;
  });

  const notes = [
    `Aligned boundary review checked ${removable.length} candidate cuts, adjusted ${adjusted}, downgraded ${downgraded}, missing ${missing}.`
  ];
  return { decisions: reviewedDecisions, llmUsage: usage, notes };
}

async function reviewCandidateCutsWithTextLlm(
  client: TextLlmClient,
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  transcript: Transcript,
  decisions: SegmentDecision[],
  maxTranscriptChars: number
): Promise<{ decisions: SegmentDecision[]; usage: LlmUsage[]; notes: string[] }> {
  const removalIds = decisions.map((decision, id) => ({ decision, id })).filter(({ decision }) => decision.action === "remove");
  if (removalIds.length === 0) return { decisions, usage: [], notes: [] };

  const usage: LlmUsage[] = [];
  const reviews = new Map<number, ParsedCutReviewEntry>();
  for (const batch of buildCutReviewBatches(removalIds, transcript, maxTranscriptChars)) {
    const prompt = buildCutReviewPrompt(podcast, episode, batch);
    const result = await postTextLlmJson(client, "ad-detection", classifierBody(prompt, maxTranscriptChars));
    if (result.usage) usage.push(result.usage);
    const parsed = parseJsonObject(result.content || "{}") as ParsedCutReview;
    for (const review of parsed.reviews ?? []) {
      const id = numberOrUndefined(review.id);
      if (id != null && removalIds.some((candidate) => candidate.id === id)) {
        reviews.set(id, review);
      }
    }
  }

  let downgraded = 0;
  let adjusted = 0;
  let missing = 0;
  const reviewedDecisions = decisions.map((decision, id) => {
    if (decision.action !== "remove") return decision;
    const review = reviews.get(id);
    if (!review) {
      missing += 1;
      downgraded += 1;
      return downgradeUnsafeCut(decision, "safety review missing");
    }
    if (review.action !== "remove") {
      downgraded += 1;
      return downgradeUnsafeCut(decision, review.reason ? `safety veto: ${review.reason}` : "safety veto");
    }
    const refined = refineCutFromReview(decision, review, transcript);
    if (Math.abs(refined.start - decision.start) > 0.001 || Math.abs(refined.end - decision.end) > 0.001) adjusted += 1;
    return refined;
  });

  const notes: string[] = [];
  if (downgraded > 0 || adjusted > 0 || missing > 0) {
    notes.push(`Cut safety review downgraded ${downgraded} proposed cuts, adjusted ${adjusted} cut boundaries, and had ${missing} missing reviews.`);
  } else {
    notes.push(`Cut safety review approved ${removalIds.length} proposed cuts.`);
  }

  return { decisions: reviewedDecisions, usage, notes };
}

function buildCutReviewBatches(
  candidates: Array<{ id: number; decision: SegmentDecision }>,
  transcript: Transcript,
  maxTranscriptChars: number
): CutReviewCandidateRecord[][] {
  const maxBatchChars = Math.max(8_000, Math.min(CUT_REVIEW_BATCH_CHAR_TARGET, Math.floor(maxTranscriptChars * 0.75)));
  const batches: CutReviewCandidateRecord[][] = [];
  let current: CutReviewCandidateRecord[] = [];
  let currentChars = 0;

  for (const candidate of candidates) {
    const record = buildCutReviewCandidate(candidate.id, candidate.decision, transcript);
    const recordChars = JSON.stringify(record).length;
    if (current.length > 0 && currentChars + recordChars > maxBatchChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(record);
    currentChars += recordChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function buildCutReviewCandidate(id: number, decision: SegmentDecision, transcript: Transcript): CutReviewCandidateRecord {
  const contextStart = Math.max(0, decision.start - CUT_REVIEW_CONTEXT_SECONDS);
  const contextEnd = decision.end + CUT_REVIEW_CONTEXT_SECONDS;
  const context = transcript.segments
    .filter((segment) => segment.end > contextStart && segment.start < contextEnd)
    .map((segment) => ({
      start: Number(segment.start.toFixed(2)),
      end: Number(segment.end.toFixed(2)),
      cut: segmentCutPosition(segment, decision),
      text: segment.text.slice(0, 500)
    }));

  return {
    id,
    proposedStart: Number(decision.start.toFixed(3)),
    proposedEnd: Number(decision.end.toFixed(3)),
    proposedDuration: Number((decision.end - decision.start).toFixed(3)),
    proposedReason: decision.reason,
    proposedAdvertiser: decision.advertiser,
    proposedText: decision.text?.slice(0, 1800),
    context
  };
}

function buildBoundaryReviewBatches(
  candidates: Array<{ id: number; decision: SegmentDecision }>,
  transcript: Transcript,
  maxTranscriptChars: number
): BoundaryReviewCandidateRecord[][] {
  const maxBatchChars = Math.max(8_000, Math.min(BOUNDARY_REVIEW_BATCH_CHAR_TARGET, Math.floor(maxTranscriptChars * 0.75)));
  const batches: BoundaryReviewCandidateRecord[][] = [];
  let current: BoundaryReviewCandidateRecord[] = [];
  let currentChars = 0;

  for (const candidate of candidates) {
    const record = buildBoundaryReviewCandidate(candidate.id, candidate.decision, transcript);
    if (record.words.length === 0) continue;
    const recordChars = JSON.stringify(record).length;
    if (current.length > 0 && currentChars + recordChars > maxBatchChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(record);
    currentChars += recordChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function buildBoundaryReviewCandidate(id: number, decision: SegmentDecision, transcript: Transcript): BoundaryReviewCandidateRecord {
  const contextStart = Math.max(0, decision.start - BOUNDARY_REVIEW_CONTEXT_SECONDS);
  const contextEnd = decision.end + BOUNDARY_REVIEW_CONTEXT_SECONDS;
  const segments = transcript.segments
    .map((segment, index) => ({ index, segment }))
    .filter(({ segment }) => segment.end > contextStart && segment.start < contextEnd)
    .map(({ index, segment }) => ({
      i: index,
      start: Number(segment.start.toFixed(2)),
      end: Number(segment.end.toFixed(2)),
      cut: segmentCutPosition(segment, decision),
      text: segment.text.slice(0, 600)
    }));
  const words = (transcript.words ?? [])
    .filter((word) => word.end > contextStart && word.start < contextEnd)
    .map((word, index) => ({
      w: index,
      start: Number(word.start.toFixed(3)),
      end: Number(word.end.toFixed(3)),
      text: word.text.slice(0, 80),
      segment: word.segmentIndex
    }));

  return {
    id,
    proposedStart: Number(decision.start.toFixed(3)),
    proposedEnd: Number(decision.end.toFixed(3)),
    proposedDuration: Number((decision.end - decision.start).toFixed(3)),
    proposedReason: decision.reason,
    proposedAdvertiser: decision.advertiser,
    segments,
    words
  };
}

function buildBoundaryReviewPrompt(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  candidates: BoundaryReviewCandidateRecord[]
): string {
  return [
    `Podcast: ${podcast.name}`,
    `Episode: ${episode.title}`,
    `Episode description clues: ${episode.description.slice(0, 1200)}`,
    "Task:",
    "Choose final destructive podcast audio cut boundaries using word-level forced-alignment data.",
    "The previous detector found broad candidate ad/noise zones. Your job is not to find new unrelated ads. Your job is to choose exact safe first and last words to remove for each candidate.",
    "Approve removal only for commercial reads, dynamically inserted ads, sponsor/ticket/merch/subscription/app/donation/betting/product/service promotions, network promos, calls to action, compliance disclaimers, and non-editorial transition noise inside the same commercial block.",
    "Preserve editorial interview, topic setup, jokes, host welcome, episode identity, guest setup, listener bits, normal conversation, and show content. If uncertain, leave the audio in.",
    "You may shrink or expand the proposed cut within the supplied word/segment context when it is clearly the same contiguous commercial block. This is needed when the broad detector clipped an ad lead-in or tail.",
    "Do not include preceding editorial setup just because it is adjacent to an ad. The first removed word should be the first word whose own role is commercial or non-editorial transition audio.",
    "Do not stop early while the same ad block is still continuing. The last removed word should be the last commercial word, call to action, disclaimer, sign-off, or transition audio before editorial resumes.",
    "If a commercial block is mixed with real content and you cannot isolate clean first/last words, choose action mark-only. Losing real podcast content is worse than leaving ad remnants.",
    "Return startWord and endWord as the local word ids from the candidate's words array. They are inclusive. Prefer word ids over timestamps.",
    "Also return startTime/endTime matching those words, plus short exact startAnchorText/endAnchorText of 2-8 words if possible.",
    "For every candidate id, return exactly one review. Strict JSON only with this shape and no extra keys:",
    "{\"reviews\":[{\"id\":0,\"action\":\"remove\",\"confidence\":0.95,\"reason\":\"paid read\",\"advertiser\":\"Example Brand\",\"startWord\":12,\"endWord\":48,\"startTime\":123.4,\"endTime\":156.7,\"startAnchorText\":\"first removed words\",\"endAnchorText\":\"last removed words\"}]}",
    "Candidates:",
    JSON.stringify(candidates)
  ].join("\n\n");
}

function boundaryReviewBody(prompt: string, maxTranscriptChars: number): Record<string, unknown> {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are a meticulous podcast ad boundary reviewer. You choose exact word-level splice boundaries and strictly prefer preserving real content over removing extra audio. Return strict JSON only."
      },
      { role: "user", content: prompt.slice(0, maxTranscriptChars) }
    ],
    temperature: 0,
    max_tokens: 1800,
    response_format: { type: "json_object" }
  };
}

function applyBoundaryReview(
  decision: SegmentDecision,
  review: ParsedBoundaryReviewEntry,
  candidate: BoundaryReviewCandidateRecord,
  transcript: Transcript
): SegmentDecision {
  if (review.action !== "remove") {
    return downgradeUnsafeCut(decision, review.reason ? `aligned boundary veto: ${review.reason}` : "aligned boundary veto");
  }

  const startWordId = numberOrUndefined(review.startWord);
  const endWordId = numberOrUndefined(review.endWord);
  const startWord = startWordId == null ? undefined : candidate.words.find((word) => word.w === startWordId);
  const endWord = endWordId == null ? undefined : candidate.words.find((word) => word.w === endWordId);
  const reviewedStart = numberOrUndefined(review.startTime);
  const reviewedEnd = numberOrUndefined(review.endTime);
  const contextStart = candidate.words[0]?.start ?? Math.max(0, decision.start - BOUNDARY_REVIEW_CONTEXT_SECONDS);
  const contextEnd = candidate.words.at(-1)?.end ?? decision.end + BOUNDARY_REVIEW_CONTEXT_SECONDS;
  const start = startWord ? startWord.start : reviewedStart == null ? decision.start : clampTime(reviewedStart, contextStart, contextEnd);
  const end = endWord ? endWord.end : reviewedEnd == null ? decision.end : clampTime(reviewedEnd, start, contextEnd);

  if (end <= start || end - start < 0.25) {
    return downgradeUnsafeCut(decision, review.reason ? `aligned boundary veto: ${review.reason}` : "aligned boundary veto");
  }

  return {
    ...decision,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    confidence: Math.max(0, Math.min(decision.confidence, review.confidence ?? decision.confidence)),
    reason: review.reason ? appendDecisionReason(review.reason.slice(0, 120), "boundary reviewed") : appendDecisionReason(decision.reason, "boundary reviewed"),
    advertiser: normalizeAdvertiser(review.advertiser) ?? decision.advertiser,
    alignment: {
      ...decision.alignment,
      startSegmentIndex: startWord?.segment ?? segmentIndexAtTime(transcript.segments, start),
      endSegmentIndex: endWord?.segment ?? segmentIndexAtTime(transcript.segments, Math.max(start, end - 0.001)),
      method: "forced-word",
      startAnchorText: normalizeAnchorText(review.startAnchorText) ?? startAnchorFromWords(candidate.words, startWordId),
      endAnchorText: normalizeAnchorText(review.endAnchorText) ?? endAnchorFromWords(candidate.words, endWordId)
    },
    text: overlappingText(transcript.segments, start, end)
  };
}

function startAnchorFromWords(words: BoundaryReviewCandidateRecord["words"], startWordId: number | undefined): string | undefined {
  if (startWordId == null) return undefined;
  const index = words.findIndex((word) => word.w === startWordId);
  if (index < 0) return undefined;
  return words
    .slice(index, Math.min(words.length, index + 6))
    .map((word) => word.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || undefined;
}

function endAnchorFromWords(words: BoundaryReviewCandidateRecord["words"], endWordId: number | undefined): string | undefined {
  if (endWordId == null) return undefined;
  const index = words.findIndex((word) => word.w === endWordId);
  if (index < 0) return undefined;
  return words
    .slice(Math.max(0, index - 5), index + 1)
    .map((word) => word.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || undefined;
}

function segmentCutPosition(
  segment: TranscriptSegment,
  decision: SegmentDecision
): "before" | "inside" | "after" | "overlap" {
  if (segment.end <= decision.start) return "before";
  if (segment.start >= decision.end) return "after";
  if (segment.start >= decision.start && segment.end <= decision.end) return "inside";
  return "overlap";
}

function buildCutReviewPrompt(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  candidates: CutReviewCandidateRecord[]
): string {
  return [
    `Podcast: ${podcast.name}`,
    `Episode: ${episode.title}`,
    `Episode description clues: ${episode.description.slice(0, 1800)}`,
    "Task:",
    "Safety-review these proposed destructive podcast audio cuts. Do not add new cuts. Do not use keyword matching, phrase lists, exact sponsor names, or assumed podcast-specific catchphrases.",
    "Approve action remove only when the proposed cut is clearly a paid commercial read, dynamically inserted ad, network promo, compliance disclaimer, direct listener call to buy/visit/download/subscribe/donate/bet/claim an offer, or non-editorial noise.",
    "Host-read promotion by the regular hosts is still removable when the primary purpose is telling listeners about tickets, live events, merchandise, subscriptions, apps, offers, donations, betting, or buying/visiting/downloading something. Do not veto solely because the regular hosts are speaking or because the event involves the show's own community.",
    "Return action keep or mark-only for editorial content, listener-submitted bits, voicemails, parody songs or jingles, recurring show games, host reactions, jokes, normal topic discussion, and mixed spans where real episode content starts or resumes inside the proposed cut.",
    "A brand, venue, product, event, or sponsor-like phrase appearing inside entertainment or conversation is not enough to approve removal.",
    "If a proposed cut includes both ad copy and real content, shrink it to the commercial-only portion instead of vetoing the entire cut. Adjusted startTime and endTime must stay inside the proposed range. Return mark-only only when the proposed range is mostly editorial or the commercial-only portion cannot be isolated.",
    "Losing real podcast content is worse than leaving a short ad remnant.",
    "For every candidate id, return exactly one review. Strict JSON only with this shape and no extra keys:",
    "{\"reviews\":[{\"id\":0,\"action\":\"remove\",\"confidence\":0.95,\"reason\":\"paid read\",\"startTime\":12.4,\"endTime\":48.9,\"startAnchorText\":\"first ad words\",\"endAnchorText\":\"last ad words\",\"advertiser\":\"Example Brand\"}]}",
    "Candidates:",
    JSON.stringify(candidates)
  ].join("\n\n");
}

function refineCutFromReview(decision: SegmentDecision, review: ParsedCutReviewEntry, transcript: Transcript): SegmentDecision {
  const reviewedStart = numberOrUndefined(review.startTime);
  const reviewedEnd = numberOrUndefined(review.endTime);
  const start = reviewedStart == null ? decision.start : clampTime(reviewedStart, decision.start, decision.end);
  const end = reviewedEnd == null ? decision.end : clampTime(reviewedEnd, start, decision.end);

  if (end <= start) {
    return downgradeUnsafeCut(decision, review.reason ? `safety veto: ${review.reason}` : "safety veto");
  }

  const startAnchorText = normalizeAnchorText(review.startAnchorText) ?? decision.alignment?.startAnchorText;
  const endAnchorText = normalizeAnchorText(review.endAnchorText) ?? decision.alignment?.endAnchorText;
  return {
    ...decision,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    confidence: Math.max(0, Math.min(decision.confidence, review.confidence ?? decision.confidence)),
    reason: review.reason ? review.reason.slice(0, 120) : appendDecisionReason(decision.reason, "reviewed"),
    advertiser: normalizeAdvertiser(review.advertiser) ?? decision.advertiser,
    alignment: {
      ...decision.alignment,
      startSegmentIndex: segmentIndexAtTime(transcript.segments, start),
      endSegmentIndex: segmentIndexAtTime(transcript.segments, Math.max(start, end - 0.001)),
      method: decision.alignment?.method ?? "model-timestamp",
      startAnchorText,
      endAnchorText
    },
    text: overlappingText(transcript.segments, start, end)
  };
}

function downgradeUnsafeCut(decision: SegmentDecision, reason: string): SegmentDecision {
  return {
    ...decision,
    action: "mark-only",
    confidence: Math.min(decision.confidence, 0.5),
    reason: appendDecisionReason(decision.reason, reason)
  };
}

function extendEndingCommercialCuts(
  decisions: SegmentDecision[],
  transcript: Transcript,
  options: { finalWindowSeconds?: number; minimumExtensionSeconds?: number } = {}
): { decisions: SegmentDecision[]; extendedDecisions: number } {
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
      end: Number(transcriptEnd.toFixed(3)),
      reason: appendDecisionReason(decision.reason, "ending ad tail"),
      alignment: {
        ...decision.alignment,
        endSegmentIndex: Math.max(0, transcript.segments.length - 1),
        method: decision.alignment?.method ?? "model-timestamp"
      },
      text: overlappingText(transcript.segments, decision.start, transcriptEnd)
    } satisfies SegmentDecision;
  });
  return { decisions: extended, extendedDecisions };
}

function appendDecisionReason(existing: string, addition: string): string {
  const base = existing.replace(/\s+/g, " ").trim();
  const extra = addition.replace(/\s+/g, " ").trim();
  if (!base) return extra.slice(0, 120);
  if (!extra || base.toLowerCase().includes(extra.toLowerCase())) return base.slice(0, 120);
  return `${base}; ${extra}`.slice(0, 120);
}

async function classifySplitWindow(
  client: TextLlmClient,
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  upstreamChapters: Array<{ startTime: number; title: string }>,
  windowIndex: number,
  windowCount: number,
  maxTranscriptChars: number,
  splitDepth: number
): Promise<{ parsed: ParsedClassification[]; usage: LlmUsage[] }> {
  const output: { parsed: ParsedClassification[]; usage: LlmUsage[] } = { parsed: [], usage: [] };
  for (const [splitIndex, splitSegments] of splitWindowSegments(windowSegments).entries()) {
    try {
      logClassifierWindow(client.provider, "started", windowIndex, windowCount, splitSegments, { splitDepth, splitPart: splitIndex + 1 });
      const prompt = buildClassifierPrompt(podcast, episode, splitSegments, upstreamChapters, windowIndex, windowCount);
      const result = await postTextLlmJson(client, "ad-detection", classifierBody(prompt, maxTranscriptChars));
      if (result.usage) output.usage.push(result.usage);
      const parsed = parseJsonObject(result.content || "{}") as ParsedClassification;
      output.parsed.push(parsed);
      logClassifierWindow(client.provider, "complete", windowIndex, windowCount, splitSegments, {
        splitDepth,
        splitPart: splitIndex + 1,
        decisions: parsed.adSegments?.length ?? 0,
        costUsd: result.usage?.costUsd
      });
    } catch (error) {
      if (isFatalTextLlmError(error)) throw error;
      if (shouldSplitClassificationError(error, splitSegments, splitDepth)) {
        const nested = await classifySplitWindow(client, podcast, episode, splitSegments, upstreamChapters, windowIndex, windowCount, maxTranscriptChars, splitDepth + 1);
        output.parsed.push(...nested.parsed);
        output.usage.push(...nested.usage);
        continue;
      }
      logClassifierWindow(client.provider, "failed", windowIndex, windowCount, splitSegments, { splitDepth, splitPart: splitIndex + 1, error: String(error) });
      throw error;
    }
  }
  return output;
}

async function classifySplitEdgeWindow(
  client: TextLlmClient,
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  label: "opening" | "ending",
  windowIndex: number,
  windowCount: number,
  maxTranscriptChars: number,
  splitDepth: number
): Promise<{ parsed: ParsedClassification[]; usage: LlmUsage[] }> {
  const output: { parsed: ParsedClassification[]; usage: LlmUsage[] } = { parsed: [], usage: [] };
  for (const [splitIndex, splitSegments] of splitWindowSegments(windowSegments).entries()) {
    try {
      logClassifierWindow(client.provider, "started", windowIndex, windowCount, splitSegments, { edge: label, splitDepth, splitPart: splitIndex + 1 });
      const prompt = buildEdgeAuditPrompt(podcast, episode, splitSegments, label);
      const result = await postTextLlmJson(client, "ad-detection", classifierBody(prompt, maxTranscriptChars));
      if (result.usage) output.usage.push(result.usage);
      const parsed = parseJsonObject(result.content || "{}") as ParsedClassification;
      output.parsed.push(parsed);
      logClassifierWindow(client.provider, "complete", windowIndex, windowCount, splitSegments, {
        edge: label,
        splitDepth,
        splitPart: splitIndex + 1,
        decisions: parsed.adSegments?.length ?? 0,
        costUsd: result.usage?.costUsd
      });
    } catch (error) {
      if (isFatalTextLlmError(error)) throw error;
      if (shouldSplitClassificationError(error, splitSegments, splitDepth)) {
        const nested = await classifySplitEdgeWindow(client, podcast, episode, splitSegments, label, windowIndex, windowCount, maxTranscriptChars, splitDepth + 1);
        output.parsed.push(...nested.parsed);
        output.usage.push(...nested.usage);
        continue;
      }
      logClassifierWindow(client.provider, "failed", windowIndex, windowCount, splitSegments, {
        edge: label,
        splitDepth,
        splitPart: splitIndex + 1,
        error: String(error)
      });
      throw error;
    }
  }
  return output;
}

function shouldSplitClassificationError(
  error: unknown,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  splitDepth: number
): boolean {
  if (splitDepth >= CLASSIFIER_SPLIT_MAX_DEPTH || windowSegments.length < CLASSIFIER_SPLIT_MIN_SEGMENTS) return false;
  if (isFatalTextLlmError(error)) return false;
  return /returned no text content|aborted|timeout|timed out|fetch failed|5\d\d|429|408|409/i.test(String(error));
}

function splitWindowSegments<T>(segments: T[]): [T[], T[]] {
  const midpoint = Math.ceil(segments.length / 2);
  return [segments.slice(0, midpoint), segments.slice(midpoint)];
}

function buildTranscriptWindows(transcript: Transcript): Array<Array<{ index: number; start: number; end: number; text: string }>> {
  const windows: Array<Array<{ index: number; start: number; end: number; text: string }>> = [];
  const lastEnd = transcript.segments.at(-1)?.end ?? 0;
  for (let start = 0; start < Math.max(lastEnd, 1); start += CLASSIFIER_WINDOW_SECONDS) {
    const end = start + CLASSIFIER_WINDOW_SECONDS + CLASSIFIER_OVERLAP_SECONDS;
    const windowSegments = transcript.segments
      .map((segment, index) => ({ index, start: segment.start, end: segment.end, text: segment.text }))
      .filter((segment) => segment.end >= Math.max(0, start - CLASSIFIER_OVERLAP_SECONDS) && segment.start <= end);
    if (windowSegments.length > 0) windows.push(windowSegments);
  }
  return windows.length > 0 ? windows : [transcript.segments.map((segment, index) => ({ index, start: segment.start, end: segment.end, text: segment.text }))];
}

function buildEdgeAuditWindows(transcript: Transcript): Array<{ label: "opening" | "ending"; segments: Array<{ index: number; start: number; end: number; text: string }> }> {
  const indexed = transcript.segments.map((segment, index) => ({ index, start: segment.start, end: segment.end, text: segment.text }));
  const lastEnd = indexed.at(-1)?.end ?? 0;
  const opening = indexed.filter((segment) => segment.start <= EDGE_AUDIT_SECONDS);
  const ending = indexed.filter((segment) => segment.end >= Math.max(0, lastEnd - EDGE_AUDIT_SECONDS));
  const windows: Array<{ label: "opening" | "ending"; segments: Array<{ index: number; start: number; end: number; text: string }> }> = [];
  if (opening.length > 0) windows.push({ label: "opening", segments: opening });
  if (ending.length > 0 && !sameSegmentIndexes(opening, ending)) windows.push({ label: "ending", segments: ending });
  return windows;
}

function sameSegmentIndexes(
  first: Array<{ index: number }>,
  second: Array<{ index: number }>
): boolean {
  if (first.length !== second.length) return false;
  return first.every((segment, index) => segment.index === second[index]?.index);
}

function buildClassifierPrompt(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  upstreamChapters: Array<{ startTime: number; title: string }>,
  windowIndex: number,
  windowCount: number
): string {
  const firstStart = windowSegments[0]?.start ?? 0;
  const lastEnd = windowSegments.at(-1)?.end ?? firstStart;
  const visibleChapters = upstreamChapters.filter((chapter) => chapter.startTime >= firstStart - 60 && chapter.startTime <= lastEnd + 60);
  const segments = windowSegments.map((segment) => ({
    i: segment.index,
    start: Number(segment.start.toFixed(2)),
    end: Number(segment.end.toFixed(2)),
    text: segment.text.slice(0, 500)
  }));

  return [
    `Podcast: ${podcast.name}`,
    `Episode: ${episode.title}`,
    `Transcript window: ${windowIndex + 1}/${windowCount}, source timeline ${firstStart.toFixed(1)}s-${lastEnd.toFixed(1)}s`,
    `Episode description clues: ${episode.description.slice(0, 1800)}`,
    `Publisher chapters near this window: ${visibleChapters.length ? JSON.stringify(visibleChapters) : "none"}`,
    `Muted topics: ${podcast.categories.muted.join(", ") || "none"}`,
    "Task:",
    "Classify this timestamped transcript window semantically. Do not use keyword matching, phrase lists, or exact sponsor names.",
    "Find removable ad/noise spans. These include paid reads, product/service pitches, sponsor acknowledgements with commercial benefits or calls to action, donation/merch/ticket/app promotions, network privacy notices, betting/gambling commercial material, dynamically inserted ads, and dead-air/noise.",
    "Preserve editorial discussion, jokes, news, listener messages, and normal topic transitions even when they mention brands, teams, venues, or products in a non-commercial way.",
    "Preserve listener submissions, voicemails, parody songs, parody jingles, call-ins, recurring show games, and host reactions to those bits. These are editorial content unless the speaker is clearly delivering a paid commercial read with a direct listener call to buy, visit, subscribe, download, bet, claim an offer, or a legal/compliance disclaimer.",
    "A brand, sponsor, venue, product, racing/betting topic, or song lyric inside a listener-submitted bit is not enough to remove it. If the segment is framed as something sent in by a listener, played for entertainment, or discussed by the hosts as show content, preserve it.",
    "Preserve normal show identity, host welcome, episode title, guest setup, and topic table-setting even when they sit between sponsor reads. If sponsor copy interrupts an intro, cut only the sponsor copy.",
    "Do not label ordinary editorial banter as product placement. A conversation about objects, awards, events, teams, venues, or plans remains editorial unless the purpose is clearly to sell, promote, invite, subscribe, donate, bet, download, visit, trial, or buy.",
    "Most professional podcast episodes contain at least one commercial span. Return an empty list only when this specific window is genuinely all editorial content.",
    "Publisher chapters are reference boundaries for editorial topics. Do not cut across a publisher chapter unless the transcript content at that time is clearly commercial or noise.",
    "Be decisive when a contiguous run is commercial. A commercial block includes its setup, host banter that sells the offer, commercial benefits, calls to action, disclaimers, and sign-off lines until editorial conversation resumes.",
    "Do not return only the brand/product sentence if the surrounding lines are still part of the same promotion. Include event, merch, subscription, app, donation, ticketing, trial, discount, store, and link/URL calls to action when they are promotional.",
    "Do not require a sponsor brand to be present. Pre-roll live-event, tour, merchandise, subscription, fundraising, network, app, ticketing, or cross-promotion should be removed when it is selling or inviting listener action before the actual episode starts.",
    "For mid-episode inserted ads, do not back up into setup banter, callbacks, jokes, or normal conversation immediately before the ad. The start timestamp should be the first segment whose own text is commercial, promo, inserted ad copy, or noise.",
    "At episode endings, if the hosts have wrapped or signed off and the remaining content is commercial, jingle-like, network promo, disconnected brand copy, or inserted ad copy, remove the whole post-roll block from the first non-editorial ad fragment through the end of that block.",
    "Be precise at the first and last timestamps so the cut does not leave the start or end of an ad behind.",
    "Return absolute source-timeline timestamps as startTime and endTime, in seconds from the original episode start.",
    "Use the transcript segment times as coarse anchors, not as hard boundaries. If only part of the first or last transcript segment is commercial, place startTime/endTime inside that segment.",
    "When a boundary falls inside a transcript segment, startAnchorText and/or endAnchorText are mandatory. Use the exact first 2-8 words to remove and the exact last 2-8 words to remove. These anchors are used later with word-level forced alignment.",
    "If you cannot provide an exact anchor for a mixed boundary, move the boundary inward so it leaves questionable audio untouched. Losing editorial content is worse than leaving a short ad remnant.",
    "Prefer under-cutting over deleting real content. Do not remove a whole mixed segment when normal episode content clearly resumes inside it.",
    "If a commercial read spans adjacent segments inside this window, merge it into one range.",
    "If multiple commercial reads are separated only by silence, music, or non-editorial transition, they may be returned as one continuous removable break.",
    "Do not merge separate commercial reads across a host welcome, show identity, editorial aside, joke, guest setup, or topic setup.",
    "Use action remove for confident ads/noise. Use mark-only only when it is a weak clue that should not be cut.",
    "For each removable span, identify the likely advertiser, product, service, event, subscription, publisher, or organization being promoted. Use advertiser:\"unknown\" only when the promoted entity is not inferable from this window.",
    "Do not generate chapters, summaries, notes, reasoning, or explanations. Keep reason values to 2-6 words. Keep advertiser values to the shortest useful name.",
    "Strict JSON only with this shape and no extra keys:",
    "{\"adSegments\":[{\"startTime\":12.4,\"endTime\":48.9,\"startAnchorText\":\"first ad words\",\"endAnchorText\":\"last ad words\",\"action\":\"remove\",\"confidence\":0.9,\"reason\":\"commercial read\",\"advertiser\":\"Example Brand\"}]}",
    "Segments:",
    JSON.stringify(segments)
  ].join("\n\n");
}

function buildEdgeAuditPrompt(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  label: "opening" | "ending"
): string {
  const firstStart = windowSegments[0]?.start ?? 0;
  const lastEnd = windowSegments.at(-1)?.end ?? firstStart;
  const segments = windowSegments.map((segment) => ({
    i: segment.index,
    start: Number(segment.start.toFixed(2)),
    end: Number(segment.end.toFixed(2)),
    text: segment.text.slice(0, 500)
  }));
  const edgeName = label === "opening" ? "episode opening" : "episode ending";
  const edgeInstruction =
    label === "opening"
      ? "For the opening, find removable pre-roll commercial/noise before the actual editorial episode starts. Do not treat a host-read sponsor, event, ticketing, merch, subscription, app, product, or service pitch as editorial just because the regular hosts are speaking. If the hosts later introduce the guest, topic, or episode, that is usually where editorial content begins."
      : "For the ending, find removable post-roll commercial/noise after the actual editorial episode has wrapped. Do not treat inserted ads, network promos, product/service pitches, disclaimers, or commercial sign-offs as editorial just because they are adjacent to the closing conversation.";

  return [
    `Podcast: ${podcast.name}`,
    `Episode: ${episode.title}`,
    `Focused audit: ${edgeName}, source timeline ${firstStart.toFixed(1)}s-${lastEnd.toFixed(1)}s`,
    "Task:",
    "Classify this edge transcript semantically. Do not use keyword matching, phrase lists, or exact sponsor names.",
    edgeInstruction,
    "Remove paid sponsor reads, host event/ticket/subscription/product promotions, calls to action, app/service/product pitches, betting/gambling material, network promos, inserted ad copy, disclaimers, and commercial sign-offs.",
    "Preserve actual editorial intro, show identity, host welcome, episode title, guest/topic setup, normal sign-off, jokes, and conversation unless the purpose is clearly to sell, promote, invite, subscribe, donate, bet, download, visit, trial, or buy.",
    "Preserve listener submissions, voicemails, parody songs, parody jingles, call-ins, recurring show games, and host reactions to those bits. Brand, sponsor, racing/betting, venue, or product mentions inside listener-submitted entertainment are not enough to remove them.",
    "Be precise. The start timestamp should be the first segment whose own text is commercial or noise. The end timestamp should be where editorial content resumes, or the end of the commercial edge block.",
    "When a boundary falls inside a transcript segment, startAnchorText and/or endAnchorText are mandatory. Use the exact first 2-8 words to remove and the exact last 2-8 words to remove. These anchors are used later with word-level forced alignment.",
    "If you cannot provide an exact anchor for a mixed boundary, move the boundary inward so it leaves questionable audio untouched. Losing editorial content is worse than leaving a short ad remnant.",
    "Return absolute source-timeline timestamps as startTime and endTime, in seconds from the original episode start.",
    "For each removable span, identify the likely advertiser, product, event, service, publisher, or organization being promoted. Use advertiser:\"unknown\" only when it is not inferable.",
    "Strict JSON only with this shape and no extra keys:",
    "{\"adSegments\":[{\"startTime\":12.4,\"endTime\":48.9,\"startAnchorText\":\"first ad words\",\"endAnchorText\":\"last ad words\",\"action\":\"remove\",\"confidence\":0.9,\"reason\":\"commercial read\",\"advertiser\":\"Example Brand\"}]}",
    "Segments:",
    JSON.stringify(segments)
  ].join("\n\n");
}

function logClassifierWindow(
  provider: TextLlmProvider,
  status: "started" | "complete" | "failed",
  windowIndex: number,
  windowCount: number,
  windowSegments: Array<{ index: number; start: number; end: number; text: string }>,
  details: Record<string, unknown> = {}
): void {
  const first = windowSegments[0];
  const last = windowSegments.at(-1);
  console.log(
    JSON.stringify({
      level: status === "failed" ? 40 : 30,
      time: Date.now(),
      scope: provider,
      mode: "windowed-ad-detection",
      window: windowIndex + 1,
      windows: windowCount,
      start: first ? Number(first.start.toFixed(3)) : undefined,
      end: last ? Number(last.end.toFixed(3)) : undefined,
      segments: windowSegments.length,
      ...details,
      msg: `${provider} ad detection window ${status}`
    })
  );
}

function classifierBody(prompt: string, maxTranscriptChars: number): Record<string, unknown> {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are a podcast ad and topic segmentation classifier. You only classify provided timestamped transcript segments. Return strict JSON only."
      },
      { role: "user", content: prompt.slice(0, maxTranscriptChars) }
    ],
    temperature: 0,
    max_tokens: 1500,
    response_format: { type: "json_object" }
  };
}

interface TextLlmClient {
  provider: TextLlmProvider;
  label: string;
  apiKey: string;
  model: string;
  endpoint: string;
}

function textLlmClient(config: LlmConfig): TextLlmClient | undefined {
  if (!config.enabled || config.provider === "none") return undefined;
  if (config.provider === "openai-compatible") {
    const apiKey = process.env.TEXT_LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY;
    if (!apiKey) throw new Error("TEXT_LLM_API_KEY is required when llm.enabled=true and provider=openai-compatible");
    const baseUrl = (process.env.TEXT_LLM_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    return {
      provider: "openai-compatible",
      label: process.env.TEXT_LLM_PROVIDER_LABEL || "OpenAI-compatible LLM",
      apiKey,
      model: config.model,
      endpoint: chatCompletionsEndpoint(baseUrl)
    };
  }
  const apiKey = process.env.TEXT_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("TEXT_LLM_API_KEY or OPENROUTER_API_KEY is required when llm.enabled=true and provider=openrouter");
  }
  const baseUrl = (process.env.TEXT_LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  return {
    provider: "openrouter",
    label: "OpenRouter",
    apiKey,
    model: config.model,
    endpoint: chatCompletionsEndpoint(baseUrl)
  };
}

function chatCompletionsEndpoint(baseUrl: string): string {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}

async function postTextLlmJson(
  client: TextLlmClient,
  purpose: LlmUsage["purpose"],
  body: Record<string, unknown>
): Promise<TextLlmJsonResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TEXT_LLM_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 360_000);
    let payload: {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
      };
    };
    try {
      const response = await fetch(client.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${client.apiKey}`,
          "content-type": "application/json",
          ...(client.provider === "openrouter"
            ? {
                "HTTP-Referer": "http://localhost:3729",
                "X-OpenRouter-Title": "podcast-proxy-v1"
              }
            : {})
        },
        body: JSON.stringify({
          model: client.model,
          ...body
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${client.label} ${purpose} failed: ${response.status} ${text}`);
        if (attempt < TEXT_LLM_MAX_ATTEMPTS && shouldRetryTextLlmStatus(response.status, text)) {
          lastError = error;
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }
      payload = JSON.parse(text) as typeof payload;
    } catch (error) {
      clearTimeout(timeout);
      if (isFatalTextLlmError(error) || attempt >= TEXT_LLM_MAX_ATTEMPTS) throw error;
      lastError = error;
      await delay(retryDelayMs(attempt));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const responseUsage = usageFromResponse(client.provider, payload.usage, purpose, payload.model ?? client.model, payload.id);
    const generationUsage =
      client.provider === "openrouter" && responseUsage?.costUsd == null && payload.id
        ? await fetchGenerationUsage(client.apiKey, payload.id, purpose, payload.model ?? client.model)
        : undefined;
    const content = extractTextContent(payload.choices?.[0]?.message?.content);
    if (content.trim()) {
      return {
        content,
        usage: mergeUsage(responseUsage, generationUsage)
      };
    }

    lastError = new Error(`${client.label} ${purpose} returned no text content`);
    if (attempt < TEXT_LLM_MAX_ATTEMPTS) {
      await delay(retryDelayMs(attempt));
      continue;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${client.label} ${purpose} failed`);
}

function shouldRetryTextLlmStatus(status: number, body: string): boolean {
  if (isFatalTextLlmError(`${status} ${body}`)) return false;
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(attempt: number): number {
  return Math.min(1000, 100 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGenerationUsage(apiKey: string, generationId: string, purpose: LlmUsage["purpose"], model: string): Promise<LlmUsage | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let payload: {
    data?: {
      model?: string;
      total_cost?: number;
      usage?: number;
      tokens_prompt?: number;
      tokens_completion?: number;
      native_tokens_prompt?: number;
      native_tokens_completion?: number;
    };
  };
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    payload = (await response.json()) as typeof payload;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
  const data = payload.data;
  if (!data) return undefined;
  const promptTokens = numberOrUndefined(data.native_tokens_prompt ?? data.tokens_prompt);
  const completionTokens = numberOrUndefined(data.native_tokens_completion ?? data.tokens_completion);
  return {
    provider: "openrouter",
    purpose,
    model: data.model ?? model,
    generationId,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined,
    costUsd: numberOrUndefined(data.total_cost ?? data.usage)
  };
}

function usageFromResponse(
  provider: LlmUsage["provider"],
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined,
  purpose: LlmUsage["purpose"],
  model: string,
  generationId: string | undefined
): LlmUsage | undefined {
  if (!usage) return undefined;
  return {
    provider,
    purpose,
    model,
    generationId,
    promptTokens: numberOrUndefined(usage.prompt_tokens),
    completionTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    costUsd: numberOrUndefined(usage.cost)
  };
}

function mergeUsage(primary: LlmUsage | undefined, fallback: LlmUsage | undefined): LlmUsage | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...primary,
    model: primary.model || fallback.model,
    generationId: primary.generationId ?? fallback.generationId,
    promptTokens: primary.promptTokens ?? fallback.promptTokens,
    completionTokens: primary.completionTokens ?? fallback.completionTokens,
    totalTokens: primary.totalTokens ?? fallback.totalTokens,
    costUsd: primary.costUsd ?? fallback.costUsd
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function isFatalTextLlmError(error: unknown): boolean {
  const message = String(error);
  return /\b(401|402|403)\b/.test(message) || /insufficient credits|requires at least|unauthorized|forbidden/i.test(message);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildChapterPrompt(podcast: EffectivePodcastConfig, transcript: Transcript): string {
  const transcriptLines = timestampedTranscriptForChapters(transcript, podcast.llm.maxTranscriptChars);
  return [
    `Podcast: ${podcast.name}`,
    `Preferred topics: ${podcast.categories.preferred.join(", ") || "none"}`,
    `Muted topics: ${podcast.categories.muted.join(", ") || "none"}`,
    "Create chapters at major topic or format changes only.",
    "Merge adjacent candidate chapters when they are the same topic, a continuation of the same discussion, or separated only by banter/ads/short asides.",
    "Do not create chapters for ads, sponsor reads, live event plugs, merch, housekeeping, credits, jingles, or short transitions.",
    "Return 4-8 chapters for a typical one-hour episode unless there are fewer real topic changes. Absolute maximum is 10.",
    "Titles should be descriptive and specific, usually 2-6 words. Prefer names/topics over generic labels like NRL, Football, Intro, Chat, Segment, or Discussion.",
    "Use the supplied timestamps as source-timeline seconds. Return startTime in seconds from the original episode start.",
    "Strict JSON only with this shape and no extra keys: {\"chapters\":[{\"startTime\":123.4,\"title\":\"Specific Topic Name\"}]}",
    "Timestamped transcript:",
    transcriptLines
  ].join("\n\n");
}

function timestampedTranscriptForChapters(transcript: Transcript, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const segment of transcript.segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `[${formatPromptTime(segment.start)}-${formatPromptTime(segment.end)}] ${text.slice(0, 260)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

function formatPromptTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function normalizeModelChapters(chapters: Chapter[]): Chapter[] {
  const normalized = chapters
    .map((chapter) => ({
      ...chapter,
      title: cleanModelChapterTitle(chapter.title)
    }))
    .filter((chapter) => chapter.title && !shouldDropModelChapterTitle(chapter.title))
    .sort((a, b) => a.startTime - b.startTime);

  const merged: Chapter[] = [];
  for (const chapter of normalized) {
    const previous = merged.at(-1);
    if (previous && similarChapterTitles(previous.title, chapter.title)) continue;
    merged.push(chapter);
    if (merged.length >= 10) break;
  }

  return merged;
}

function cleanModelChapterTitle(value: string): string {
  const cleaned = value
    .replace(/^(discussion|segment|topic|chapter|game|interview)\s*:\s*/i, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+-\s+/g, " ")
    .replace(/[^\w\s'&/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(/\s+/)
    .slice(0, 6)
    .map((word) => {
      const upper = word.toUpperCase();
      return ["AFL", "NRL", "NBA", "NFL", "MLB", "NHL", "UFC", "F1", "IPL"].includes(upper) ? upper : word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function shouldDropModelChapterTitle(title: string): boolean {
  const lowered = title.toLowerCase();
  if (/\b(ad|ads|advertisement|sponsor|sponsored|promo|commercial break)\b/i.test(title)) return true;
  return ["intro", "start", "discussion", "topic", "segment", "chat", "nrl", "afl", "football", "cricket", "sport"].includes(lowered);
}

function similarChapterTitles(first: string, second: string): boolean {
  const firstTokens = chapterTitleTokens(first);
  const secondTokens = chapterTitleTokens(second);
  if (firstTokens.length === 0 || secondTokens.length === 0) return true;
  const overlap = firstTokens.filter((token) => secondTokens.includes(token)).length;
  const smaller = Math.min(firstTokens.length, secondTokens.length);
  return overlap >= Math.max(2, smaller) || firstTokens.join(" ") === secondTokens.join(" ");
}

function chapterTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !["and", "with", "the", "for", "from", "into", "about"].includes(token));
}

export function parsedAdSegmentToDecision(entry: ParsedAdSegment, transcript: Transcript): SegmentDecision | undefined {
  const absolute = absoluteBoundsFromEntry(entry, transcript.segments);
  const segmentAligned = absolute ?? segmentBoundsFromEntry(entry, transcript.segments);
  if (!segmentAligned) return undefined;
  const { start, end, startSegmentIndex, endSegmentIndex, method } = segmentAligned;
  if (end <= start) return undefined;
  return {
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    action: entry.action ?? "remove",
    confidence: Math.max(0, Math.min(1, entry.confidence ?? 0.75)),
    reason: (entry.reason ?? "model ad classification").slice(0, 120),
    advertiser: normalizeAdvertiser(entry.advertiser),
    source: "model",
    alignment: {
      startSegmentIndex,
      endSegmentIndex,
      method,
      startAnchorText: normalizeAnchorText(entry.startAnchorText),
      endAnchorText: normalizeAnchorText(entry.endAnchorText)
    },
    text: overlappingText(transcript.segments, start, end)
  };
}

function normalizeAnchorText(value: string | undefined): string | undefined {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned || /^unknown|n\/a|null|none$/i.test(cleaned)) return undefined;
  return cleaned.slice(0, 160);
}

function absoluteBoundsFromEntry(
  entry: ParsedAdSegment,
  segments: TranscriptSegment[]
): { start: number; end: number; startSegmentIndex: number; endSegmentIndex: number; method: "model-timestamp" } | undefined {
  const startTime = numberOrUndefined(entry.startTime);
  const endTime = numberOrUndefined(entry.endTime);
  if (startTime == null || endTime == null || segments.length === 0) return undefined;
  const duration = Math.max(...segments.map((segment) => segment.end));
  const start = clampTime(Math.min(startTime, endTime), 0, duration);
  const end = clampTime(Math.max(startTime, endTime), 0, duration);
  if (end <= start) return undefined;
  return {
    start,
    end,
    startSegmentIndex: segmentIndexAtTime(segments, start),
    endSegmentIndex: segmentIndexAtTime(segments, Math.max(start, end - 0.001)),
    method: "model-timestamp"
  };
}

function segmentBoundsFromEntry(
  entry: ParsedAdSegment,
  segments: TranscriptSegment[]
):
  | {
      start: number;
      end: number;
      startSegmentIndex: number;
      endSegmentIndex: number;
      method: "stt-chunk" | "feed-transcript-segment";
    }
  | undefined {
  const startSegment = clampSegmentIndex(entry.startSegment ?? -1, segments.length);
  const endSegment = clampSegmentIndex(entry.endSegment ?? entry.startSegment ?? -1, segments.length);
  if (startSegment < 0 || endSegment < 0) return undefined;
  const orderedStart = Math.min(startSegment, endSegment);
  const orderedEnd = Math.max(startSegment, endSegment);
  const startSegmentData = segments[orderedStart];
  const endSegmentData = segments[orderedEnd];
  const start = boundaryTimeFromOffset(entry.startOffsetSeconds, startSegmentData, startSegmentData.start);
  const end = boundaryTimeFromOffset(entry.endOffsetSeconds, endSegmentData, endSegmentData.end);
  if (end <= start) return undefined;
  return {
    start,
    end,
    startSegmentIndex: orderedStart,
    endSegmentIndex: orderedEnd,
    method: "stt-chunk"
  };
}

function boundaryTimeFromOffset(value: number | undefined, segment: TranscriptSegment, fallbackAbsolute: number): number {
  if (value == null || !Number.isFinite(value)) return fallbackAbsolute;
  if (value >= segment.start - 0.25 && value <= segment.end + 0.25) {
    return clampTime(value, segment.start, segment.end);
  }
  return segment.start + clampTime(value, 0, Math.max(0, segment.end - segment.start));
}

function segmentIndexAtTime(segments: TranscriptSegment[], time: number): number {
  for (const [index, segment] of segments.entries()) {
    if (time >= segment.start - 0.001 && time <= segment.end + 0.001) return index;
    if (time < segment.start) return Math.max(0, index - 1);
  }
  return Math.max(0, segments.length - 1);
}

function overlappingText(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => segment.text)
    .join(" ")
    .slice(0, 1200);
}

function coalesceModelAdBlocks(decisions: SegmentDecision[], segments: TranscriptSegment[]): SegmentDecision[] {
  const remove = decisions
    .filter((decision) => decision.action === "remove" && decision.confidence >= 0.85)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const other = decisions.filter((decision) => decision.action !== "remove" || decision.confidence < 0.85);
  const merged: SegmentDecision[] = [];
  for (const decision of remove) {
    const previous = merged.at(-1);
    if (previous && canBridgeAdBlocks(previous, decision, segments)) {
      previous.end = Math.max(previous.end, decision.end);
      previous.confidence = Math.min(previous.confidence, decision.confidence);
      previous.reason = previous.reason === decision.reason ? previous.reason : "commercial block";
      previous.advertiser = mergeAdvertisers(previous.advertiser, decision.advertiser);
      previous.alignment = {
        startSegmentIndex: previous.alignment?.startSegmentIndex,
        endSegmentIndex: decision.alignment?.endSegmentIndex ?? previous.alignment?.endSegmentIndex,
        method: "model-timestamp"
      };
      previous.text = overlappingText(segments, previous.start, previous.end);
      continue;
    }
    merged.push({ ...decision });
  }
  return [...merged, ...other].sort((a, b) => a.start - b.start || a.end - b.end);
}

function canBridgeAdBlocks(previous: SegmentDecision, next: SegmentDecision, segments: TranscriptSegment[]): boolean {
  const gapSeconds = next.start - previous.end;
  if (gapSeconds <= 1) return true;
  if (gapSeconds > AD_BLOCK_BRIDGE_SECONDS) return false;
  const gapSegments = segments.filter((segment) => segment.end > previous.end + 0.05 && segment.start < next.start - 0.05);
  if (gapSegments.length === 0) return gapSeconds <= 3;
  return gapSegments.every(isNonSpeechTransition);
}

function isNonSpeechTransition(segment: TranscriptSegment): boolean {
  const text = segment.text.replace(/\s+/g, " ").trim();
  return !text || /^\[(music|theme|jingle|silence|pause|sound|sfx|applause|intro|outro)\]$/i.test(text);
}

function normalizeAdvertiser(value: string | undefined): string | undefined {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned || /^unknown|n\/a|null|none$/i.test(cleaned)) return undefined;
  return cleaned.slice(0, 80);
}

function mergeAdvertisers(first: string | undefined, second: string | undefined): string | undefined {
  const values = [first, second].filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values.flatMap((value) => value.split(/\s*;\s*/)).filter(Boolean)));
  return unique.slice(0, 3).join("; ") || undefined;
}

function clampSegmentIndex(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= length) return -1;
  return value;
}

function clampTime(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model did not return JSON: ${content.slice(0, 300)}`);
    return JSON.parse(match[0]);
  }
}
