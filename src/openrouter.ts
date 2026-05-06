import type { Chapter, DetectionResult, EffectivePodcastConfig, LlmUsage, ParsedEpisode, SegmentDecision, Transcript, TranscriptSegment } from "./types.js";

interface OpenRouterJsonResult {
  content: string;
  usage?: LlmUsage;
}

const CLASSIFIER_WINDOW_SECONDS = 300;
const CLASSIFIER_OVERLAP_SECONDS = 20;
const AD_BLOCK_BRIDGE_SECONDS = 20;

type ParsedAdSegment = {
  startTime?: number;
  endTime?: number;
  startSegment?: number;
  endSegment?: number;
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

export async function generateChaptersWithOpenRouter(podcast: EffectivePodcastConfig, transcript: Transcript): Promise<{ chapters: Chapter[]; usage?: LlmUsage }> {
  if (!podcast.llm.enabled || podcast.llm.provider !== "openrouter") return { chapters: [] };
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when llm.enabled=true and provider=openrouter");
  }

  const prompt = buildPrompt(podcast, transcript);
  const result = await postOpenRouterJson(apiKey, podcast.llm.model, "chapter-generation", {
    messages: [
      {
        role: "system",
        content:
          "You create concise podcast topic chapters from transcripts. Return strict JSON only: {\"chapters\":[{\"startTime\":number,\"title\":string}]}. Return at most 10 chapters. Titles must be 1-4 words, topic-only, no prefixes like Discussion:, no sponsor/ad/promo chapters."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    response_format: { type: "json_object" }
  });
  const parsed = JSON.parse(result.content || "{\"chapters\":[]}") as { chapters?: Chapter[] };
  const chapters = (parsed.chapters ?? [])
    .filter((chapter) => typeof chapter.startTime === "number" && chapter.title)
    .map((chapter) => ({ startTime: chapter.startTime, title: chapter.title.slice(0, 80) }));
  return { chapters, usage: result.usage };
}

export async function classifyTranscriptWithOpenRouter(
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  transcript: Transcript
): Promise<DetectionResult> {
  if (!podcast.llm.enabled || podcast.llm.provider !== "openrouter" || transcript.segments.length === 0) {
    return { decisions: [], untimedSignals: [], modelNotes: [] };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when llm.enabled=true and provider=openrouter");
  }

  const upstreamChapters = episode.chapters.map((chapter) => ({
    startTime: Number(chapter.startTime.toFixed(2)),
    title: chapter.title.slice(0, 120)
  }));

  const usage: LlmUsage[] = [];
  const parsedWindows: ParsedClassification[] = [];
  const windows = buildTranscriptWindows(transcript);
  const notes: string[] = [];

  for (const [windowIndex, windowSegments] of windows.entries()) {
    try {
      logClassifierWindow("started", windowIndex, windows.length, windowSegments);
      const prompt = buildClassifierPrompt(podcast, episode, windowSegments, upstreamChapters, windowIndex, windows.length);
      const result = await postOpenRouterJson(apiKey, podcast.llm.model, "ad-detection", classifierBody(prompt, podcast.llm.maxTranscriptChars));
      if (result.usage) usage.push(result.usage);
      const parsed = parseJsonObject(result.content || "{}") as ParsedClassification;
      parsedWindows.push(parsed);
      logClassifierWindow("complete", windowIndex, windows.length, windowSegments, {
        decisions: parsed.adSegments?.length ?? 0,
        costUsd: result.usage?.costUsd
      });
    } catch (error) {
      notes.push(`Window ${windowIndex + 1}/${windows.length} classification failed: ${String(error)}`);
      logClassifierWindow("failed", windowIndex, windows.length, windowSegments, { error: String(error) });
      if (isFatalOpenRouterError(error)) {
        throw new Error(`OpenRouter ad detection failed for window ${windowIndex + 1}/${windows.length}: ${String(error)}`);
      }
    }
  }

  if (notes.length > 0) {
    throw new Error(`OpenRouter ad detection failed for ${notes.length}/${windows.length} transcript windows: ${notes.slice(0, 3).join(" | ")}`);
  }

  const decisions = coalesceModelAdBlocks(
    parsedWindows
      .flatMap((parsed) => parsed.adSegments ?? [])
      .map((entry) => parsedAdSegmentToDecision(entry, transcript))
      .filter((entry): entry is SegmentDecision => Boolean(entry)),
    transcript.segments
  );

  return {
    decisions,
    untimedSignals: [],
    modelNotes: notes,
    chapters: [],
    llmUsage: usage
  };
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
    "Use the transcript segment times as alignment anchors. If only part of the first or last transcript segment is commercial, place startTime/endTime inside that segment.",
    "Prefer under-cutting over deleting real content. Do not remove a whole mixed segment when normal episode content clearly resumes inside it.",
    "If a commercial read spans adjacent segments inside this window, merge it into one range.",
    "If multiple commercial reads are separated only by silence, music, or non-editorial transition, they may be returned as one continuous removable break.",
    "Use action remove for confident ads/noise. Use mark-only only when it is a weak clue that should not be cut.",
    "For each removable span, identify the likely advertiser, product, service, event, subscription, publisher, or organization being promoted. Use advertiser:\"unknown\" only when the promoted entity is not inferable from this window.",
    "Do not generate chapters, summaries, notes, reasoning, or explanations. Keep reason values to 2-6 words. Keep advertiser values to the shortest useful name.",
    "Strict JSON only with this shape and no extra keys:",
    "{\"adSegments\":[{\"startTime\":12.4,\"endTime\":48.9,\"action\":\"remove\",\"confidence\":0.9,\"reason\":\"commercial read\",\"advertiser\":\"Example Brand\"}]}",
    "Segments:",
    JSON.stringify(segments)
  ].join("\n\n");
}

function logClassifierWindow(
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
      scope: "openrouter",
      mode: "windowed-ad-detection",
      window: windowIndex + 1,
      windows: windowCount,
      start: first ? Number(first.start.toFixed(3)) : undefined,
      end: last ? Number(last.end.toFixed(3)) : undefined,
      segments: windowSegments.length,
      ...details,
      msg: `openrouter ad detection window ${status}`
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
    max_tokens: 900,
    response_format: { type: "json_object" }
  };
}

async function postOpenRouterJson(
  apiKey: string,
  model: string,
  purpose: LlmUsage["purpose"],
  body: Record<string, unknown>
): Promise<OpenRouterJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 360_000);
  let payload: {
    id?: string;
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  };
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "http://localhost:3729",
        "X-OpenRouter-Title": "podcast-proxy-v1"
      },
      body: JSON.stringify({
        model,
        ...body
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter ${purpose} failed: ${response.status} ${text}`);
    }
    payload = JSON.parse(text) as typeof payload;
  } finally {
    clearTimeout(timeout);
  }
  const responseUsage = usageFromResponse(payload.usage, purpose, payload.model ?? model, payload.id);
  const generationUsage = responseUsage?.costUsd == null && payload.id ? await fetchGenerationUsage(apiKey, payload.id, purpose, payload.model ?? model) : undefined;
  return {
    content: payload.choices?.[0]?.message?.content ?? "{}",
    usage: mergeUsage(responseUsage, generationUsage)
  };
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
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined,
  purpose: LlmUsage["purpose"],
  model: string,
  generationId: string | undefined
): LlmUsage | undefined {
  if (!usage) return undefined;
  return {
    provider: "openrouter",
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

function isFatalOpenRouterError(error: unknown): boolean {
  const message = String(error);
  return /\b(401|402|403)\b/.test(message) || /insufficient credits|requires at least|unauthorized|forbidden/i.test(message);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildPrompt(podcast: EffectivePodcastConfig, transcript: Transcript): string {
  const text = transcript.text.slice(0, podcast.llm.maxTranscriptChars);
  return [
    `Podcast: ${podcast.name}`,
    `Preferred topics: ${podcast.categories.preferred.join(", ") || "none"}`,
    `Muted topics: ${podcast.categories.muted.join(", ") || "none"}`,
    "Create chapters at natural topic changes. Return at most 10. Chapter titles must be 1-4 words, topic-only, no prefixes like Discussion:, and no sponsor/ad/promo chapters.",
    "Transcript:",
    text
  ].join("\n\n");
}

function normalizeModelChapters(chapters: Chapter[]): Chapter[] {
  return chapters
    .map((chapter) => ({
      ...chapter,
      title: chapter.title
        .replace(/^(discussion|segment|topic|chapter|game|interview)\s*:\s*/i, "")
        .replace(/\[[^\]]+\]/g, "")
        .replace(/\s+-\s+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    }))
    .filter((chapter) => chapter.title && !/\b(ad|ads|advertisement|sponsor|sponsored|promo|commercial break)\b/i.test(chapter.title))
    .map((chapter) => ({
      ...chapter,
      title: chapter.title
        .split(/\s+/)
        .filter((word) => !["and", "with", "the", "a", "an", "on", "of", "to", "for", "in", "discussion"].includes(word.toLowerCase()))
        .slice(0, 4)
        .join(" ")
    }))
    .filter((chapter) => chapter.title)
    .slice(0, 10);
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
      method
    },
    text: overlappingText(transcript.segments, start, end)
  };
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
    if (previous && decision.start <= previous.end + AD_BLOCK_BRIDGE_SECONDS) {
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
