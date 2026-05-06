import type { Chapter, DetectionResult, EffectivePodcastConfig, LlmUsage, ParsedEpisode, SegmentDecision, Transcript } from "./types.js";

interface OpenRouterJsonResult {
  content: string;
  usage?: LlmUsage;
}

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

  const segments = transcript.segments.map((segment, index) => ({
    i: index,
    start: Number(segment.start.toFixed(2)),
    end: Number(segment.end.toFixed(2)),
    text: segment.text.slice(0, 500)
  }));
  const upstreamChapters = episode.chapters.map((chapter) => ({
    startTime: Number(chapter.startTime.toFixed(2)),
    title: chapter.title.slice(0, 120)
  }));

  const prompt = [
    `Podcast: ${podcast.name}`,
    `Episode: ${episode.title}`,
    `Episode description clues: ${episode.description.slice(0, 2500)}`,
    `Publisher chapters, if any. Treat these as source-timeline topic references, often manually curated by the publisher: ${upstreamChapters.length ? JSON.stringify(upstreamChapters) : "none"}`,
    `Muted topics: ${podcast.categories.muted.join(", ") || "none"}`,
    "Task:",
    "Identify commercial ad, sponsorship, promo, donation, merch, ticket sales, app-install, network privacy, gambling/betting, and dead-air/noise segments.",
    "This is semantic classification. There are no keyword rules or phrase lists, but clear paid reads, product/service pitches, sponsor acknowledgements with benefits or calls to action, gambling disclaimers tied to betting reads, event ticket promos, and post-roll inserted ads should be removed.",
    "Ad detection is the primary task. Be decisive for transcript windows that are mostly commercial, while still preserving normal editorial discussion.",
    "Return segment index ranges plus optional boundary offsets inside the first and last segment.",
    "Offsets are seconds from the segment start. Use them for mixed transition segments where the ad starts or ends mid-segment, so cuts do not snap to the whole chunk.",
    "Prefer under-cutting over deleting real content. Do not remove a whole mixed segment when normal episode content clearly resumes inside it.",
    "If a sponsor read spans adjacent segments, merge it into one range.",
    "Use action remove for ads/noise. Use mark-only only when it is a weak clue that should not be cut.",
    upstreamChapters.length
      ? "Publisher chapters already exist. Use them as reference context for classification and return an empty chapters array unless the transcript reveals a clearly missing major topic."
      : "Also create useful topic chapters by segment index when topic changes are clear. Return at most 10 chapters. Chapter titles must be 1-4 words, topic-only, and must not use prefixes like Discussion:, Segment:, Game:, or Topic:. Do not create sponsor/ad/promo chapters.",
    "Strict JSON only with this shape:",
    "{\"adSegments\":[{\"startSegment\":0,\"endSegment\":1,\"startOffsetSeconds\":0,\"endOffsetSeconds\":8.5,\"action\":\"remove\",\"confidence\":0.9,\"reason\":\"sponsor read\"}],\"chapters\":[{\"segment\":0,\"title\":\"Intro\"}],\"notes\":[\"...\"]}",
    "Segments:",
    JSON.stringify(segments)
  ].join("\n\n");

  const result = await postOpenRouterJson(apiKey, podcast.llm.model, "ad-detection", {
    messages: [
      {
        role: "system",
        content:
          "You are a podcast ad and topic segmentation classifier. You only classify provided timestamped transcript segments. Return strict JSON only."
      },
      { role: "user", content: prompt.slice(0, podcast.llm.maxTranscriptChars) }
    ],
    temperature: 0,
    max_tokens: 2500,
    response_format: { type: "json_object" }
  });

  const content = result.content || "{}";
  const parsed = parseJsonObject(content) as {
    adSegments?: Array<{
      startSegment?: number;
      endSegment?: number;
      action?: "remove" | "keep" | "mark-only";
      confidence?: number;
      reason?: string;
      startOffsetSeconds?: number;
      endOffsetSeconds?: number;
    }>;
    chapters?: Array<{ segment?: number; title?: string }>;
    notes?: string[];
  };

  const decisions = (parsed.adSegments ?? [])
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
          method: transcript.source.startsWith("openrouter-stt") || transcript.source.startsWith("openai:")
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

  const chapters = normalizeModelChapters(
    (parsed.chapters ?? [])
    .map((entry): Chapter | undefined => {
      if (entry.segment == null || !entry.title) return undefined;
      const index = clampSegmentIndex(entry.segment, transcript.segments.length);
      if (index < 0) return undefined;
      return { startTime: transcript.segments[index].start, title: entry.title.slice(0, 80) };
    })
    .filter((entry): entry is Chapter => Boolean(entry))
  );

  return {
    decisions,
    untimedSignals: [],
    modelNotes: parsed.notes ?? [],
    chapters,
    llmUsage: result.usage ? [result.usage] : []
  };
}

async function postOpenRouterJson(
  apiKey: string,
  model: string,
  purpose: LlmUsage["purpose"],
  body: Record<string, unknown>
): Promise<OpenRouterJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
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
