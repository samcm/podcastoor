import type { Chapter, DetectionResult, EffectivePodcastConfig, LlmUsage, ParsedEpisode, SegmentDecision, Transcript } from "./types.js";

interface OpenRouterJsonResult {
  content: string;
  usage?: LlmUsage;
}

const CLASSIFIER_WINDOW_SECONDS = 600;
const CLASSIFIER_OVERLAP_SECONDS = 20;

type ParsedClassification = {
  adSegments?: Array<{
    startSegment?: number;
    endSegment?: number;
    action?: "remove" | "keep" | "mark-only";
    confidence?: number;
    reason?: string;
    startOffsetSeconds?: number;
    endOffsetSeconds?: number;
  }>;
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
    }
  }

  const decisions = parsedWindows
    .flatMap((parsed) => parsed.adSegments ?? [])
    .map((entry): SegmentDecision | undefined => {
      const startSegment = clampSegmentIndex(entry.startSegment ?? -1, transcript.segments.length);
      const endSegment = clampSegmentIndex(entry.endSegment ?? entry.startSegment ?? -1, transcript.segments.length);
      if (startSegment < 0 || endSegment < 0) return undefined;
      const orderedStart = Math.min(startSegment, endSegment);
      const orderedEnd = Math.max(startSegment, endSegment);
      const startSegmentData = transcript.segments[orderedStart];
      const endSegmentData = transcript.segments[orderedEnd];
      const start = startSegmentData.start + clampOffset(entry.startOffsetSeconds, startSegmentData, 0);
      const end = endSegmentData.start + clampOffset(entry.endOffsetSeconds, endSegmentData, endSegmentData.end - endSegmentData.start);
      if (end <= start) return undefined;
      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        action: entry.action ?? "remove",
        confidence: Math.max(0, Math.min(1, entry.confidence ?? 0.75)),
        reason: entry.reason ?? "OpenRouter transcript segment classification",
        source: "model" as const,
        alignment: {
          startSegmentIndex: orderedStart,
          endSegmentIndex: orderedEnd,
          method: transcript.source.startsWith("openrouter-stt") || transcript.source.startsWith("openrouter-audio-chat") || transcript.source.startsWith("openai:")
            ? ("stt-chunk" as const)
            : ("feed-transcript-segment" as const)
        },
        text: transcript.segments
          .slice(orderedStart, orderedEnd + 1)
          .map((segment) => segment.text)
          .join(" ")
          .slice(0, 1200)
      };
    })
    .filter((entry): entry is SegmentDecision => Boolean(entry));

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
    "Most professional podcast episodes contain at least one commercial span. Return an empty list only when this specific window is genuinely all editorial content.",
    "Be decisive when a contiguous run is commercial. Be precise when only part of the first or last transcript segment is commercial.",
    "Return global segment index ranges plus optional boundary offsets inside the first and last segment.",
    "Offsets are seconds from that segment's start. Use offsets for mixed transition segments so cuts do not snap to a whole segment unnecessarily.",
    "Prefer under-cutting over deleting real content. Do not remove a whole mixed segment when normal episode content clearly resumes inside it.",
    "If a commercial read spans adjacent segments inside this window, merge it into one range.",
    "Use action remove for confident ads/noise. Use mark-only only when it is a weak clue that should not be cut.",
    "Do not generate chapters, summaries, notes, reasoning, or explanations. Keep reason values to 2-6 words.",
    "Strict JSON only with this shape and no extra keys:",
    "{\"adSegments\":[{\"startSegment\":0,\"endSegment\":1,\"startOffsetSeconds\":0,\"endOffsetSeconds\":8.5,\"action\":\"remove\",\"confidence\":0.9,\"reason\":\"sponsor read\"}]}",
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

function clampSegmentIndex(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= length) return -1;
  return value;
}

function clampOffset(value: number | undefined, segment: { start: number; end: number }, fallback: number): number {
  const duration = Math.max(0, segment.end - segment.start);
  if (value == null || !Number.isFinite(value)) return Math.max(0, Math.min(duration, fallback));
  return Math.max(0, Math.min(duration, value));
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
