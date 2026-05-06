import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig, EffectivePodcastConfig, ParsedEpisode, Transcript, TranscriptSegment } from "./types.js";
import { ensureDir, formatTimestamp, parseTimestamp, stripHtml, textOf } from "./utils.js";
import { episodePaths } from "./storage.js";

const execFileAsync = promisify(execFile);

export async function acquireTranscript(
  config: AppConfig,
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  options: { sourceAudioPath?: string; dryRun: boolean }
): Promise<Transcript | undefined> {
  for (const provider of orderedTranscriptProviders(podcast.transcripts.preferred)) {
    if (provider === "feed" && podcast.transcripts.providers.feed.enabled) {
      const transcript = await acquireFeedTranscript(episode);
      if (transcript) return transcript;
    }
    if (provider === "pocketCasts" && podcast.transcripts.providers.pocketCasts.enabled) {
      const transcript = await acquirePocketCastsTranscript(podcast, episode);
      if (transcript) return transcript;
    }
    if (provider === "openRouter" && options.sourceAudioPath && podcast.transcripts.providers.openRouter.enabled && !options.dryRun) {
      return acquireOpenRouterTranscript(podcast, options.sourceAudioPath);
    }
    if (provider === "openai" && options.sourceAudioPath && podcast.transcripts.providers.openai.enabled && !options.dryRun) {
      return acquireOpenAiTranscript(podcast, options.sourceAudioPath);
    }
  }

  return undefined;
}

function orderedTranscriptProviders(preferred: EffectivePodcastConfig["transcripts"]["preferred"]): Array<EffectivePodcastConfig["transcripts"]["preferred"]> {
  return [preferred, ..."feed pocketCasts openRouter openai".split(" ")].filter(
    (provider, index, providers): provider is EffectivePodcastConfig["transcripts"]["preferred"] =>
      providers.indexOf(provider) === index
  );
}

export async function writeTranscriptArtifacts(config: AppConfig, podcastSlug: string, episodeKey: string, transcript: Transcript): Promise<string | undefined> {
  if (transcript.segments.length === 0 && !transcript.text) return undefined;
  const paths = episodePaths(config, podcastSlug, episodeKey);
  await ensureDir(paths.dir);
  await writeFile(paths.transcriptJson, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  await writeFile(paths.transcriptVtt, transcriptToVtt(transcript), "utf8");
  return paths.transcriptVtt;
}

export function transcriptToVtt(transcript: Transcript): string {
  if (transcript.segments.length === 0) {
    return `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${transcript.text.trim()}\n`;
  }
  const cues = transcript.segments.map((segment, index) => {
    return `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${segment.text.trim()}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

export function parseVtt(source: string, label = "vtt"): Transcript {
  const segments: TranscriptSegment[] = [];
  const lines = source.replace(/\r/g, "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.includes("-->")) continue;
    const [startRaw, endRaw] = line.split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const textLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      textLines.push(lines[index]);
      index += 1;
    }
    segments.push({
      start: parseTimestamp(startRaw),
      end: parseTimestamp(endRaw),
      text: stripHtml(textLines.join(" "))
    });
  }
  return {
    source: label,
    format: "text/vtt",
    text: segments.map((segment) => segment.text).join(" "),
    segments
  };
}

export function parsePodcastIndexJson(source: string, label = "podcastindex-json"): Transcript {
  const parsed = JSON.parse(source) as unknown;
  const segments = extractPodcastIndexSegments(parsed);
  return {
    source: label,
    format: "application/json",
    text: segments.map((segment) => segment.text).join(" "),
    segments
  };
}

async function acquireFeedTranscript(episode: ParsedEpisode): Promise<Transcript | undefined> {
  const ref = episode.transcripts.find((candidate) =>
    ["text/vtt", "application/json", "application/json+transcript", "application/x-subrip", "text/html"].includes(candidate.type)
  );
  if (!ref) return undefined;
  const response = await fetch(ref.url);
  if (!response.ok) return undefined;
  const body = await response.text();
  if (ref.type === "text/vtt") return parseVtt(body, ref.url);
  if (ref.type.includes("json")) return parsePodcastIndexJson(body, ref.url);
  return {
    source: ref.url,
    format: ref.type,
    language: ref.language,
    text: stripHtml(body),
    segments: []
  };
}

async function acquirePocketCastsTranscript(podcast: EffectivePodcastConfig, episode: ParsedEpisode): Promise<Transcript | undefined> {
  const template = podcast.transcripts.providers.pocketCasts.endpointTemplate;
  if (!template) return undefined;
  const url = template
    .replaceAll("{guid}", encodeURIComponent(episode.guid))
    .replaceAll("{episodeKey}", encodeURIComponent(episode.key))
    .replaceAll("{feedUrl}", encodeURIComponent(podcast.feedUrl));
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const body = await response.text();
  return body.trim().startsWith("{") ? parsePodcastIndexJson(body, url) : parseVtt(body, url);
}

async function acquireOpenAiTranscript(podcast: EffectivePodcastConfig, sourceAudioPath: string): Promise<Transcript | undefined> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const form = new FormData();
  const audio = await readFile(sourceAudioPath);
  form.set("file", new Blob([audio]), "episode.mp3");
  form.set("model", podcast.transcripts.providers.openai.model);
  form.set("response_format", "vtt");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }
  return parseVtt(await response.text(), `openai:${podcast.transcripts.providers.openai.model}`);
}

async function acquireOpenRouterTranscript(podcast: EffectivePodcastConfig, sourceAudioPath: string): Promise<Transcript | undefined> {
  const provider = podcast.transcripts.providers.openRouter;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when transcripts.providers.openRouter.enabled=true");
  }

  const duration = await probeDuration(sourceAudioPath);
  const mode = provider.mode ?? "stt";
  const chunkSeconds = Math.max(5, provider.chunkSeconds);
  const outputDir = await mkdtemp(path.join(tmpdir(), "podcast-proxy-openrouter-transcript-"));
  const chunks = Array.from({ length: Math.ceil(duration / chunkSeconds) }, (_, index) => {
    const start = index * chunkSeconds;
    return {
      index,
      start,
      end: Math.min(duration, start + chunkSeconds),
      path: path.join(outputDir, `chunk-${String(index).padStart(4, "0")}.mp3`)
    };
  });

  try {
    await mapWithConcurrency(
      chunks,
      Math.min(4, Math.max(1, provider.concurrency)),
      (chunk) =>
        runFfmpeg([
          "-y",
          "-ss",
          String(chunk.start),
          "-t",
          String(chunk.end - chunk.start),
          "-i",
          sourceAudioPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-acodec",
          "libmp3lame",
          "-b:a",
          "96k",
          chunk.path
        ])
    );

    let totalCost = 0;
    let totalSeconds = 0;
    const results = await mapWithConcurrency(chunks, Math.max(1, provider.concurrency), async (chunk) => {
      logTranscriptProgress("openrouter transcript chunk started", {
        mode,
        model: provider.model,
        chunk: chunk.index + 1,
        chunks: chunks.length,
        durationSeconds: Number((chunk.end - chunk.start).toFixed(3))
      });
      const audio = (await readFile(chunk.path)).toString("base64");
      const payload =
        mode === "audioChat"
          ? await transcribeOpenRouterAudioChatChunk({
              apiKey,
              model: provider.model,
              audioBase64: audio,
              durationSeconds: chunk.end - chunk.start,
              chunkIndex: chunk.index + 1,
              chunkCount: chunks.length
            })
          : await transcribeOpenRouterChunk({
              apiKey,
              model: provider.model,
              language: provider.language,
              audioBase64: audio
            });
      totalCost += Number(payload.usage?.cost ?? 0);
      totalSeconds += Number(payload.usage?.seconds ?? chunk.end - chunk.start);
      const localSegments =
        payload.segments?.length
          ? payload.segments
          : [{ start: 0, end: chunk.end - chunk.start, text: stripHtml(payload.text ?? "").trim() }];
      logTranscriptProgress("openrouter transcript chunk complete", {
        mode,
        model: provider.model,
        chunk: chunk.index + 1,
        chunks: chunks.length,
        segments: localSegments.length,
        cost: payload.usage?.cost
      });
      return localSegments
        .map((segment) => ({
          start: Number((chunk.start + Math.max(0, segment.start)).toFixed(3)),
          end: Number((chunk.start + Math.min(chunk.end - chunk.start, segment.end)).toFixed(3)),
          text: stripHtml(segment.text).trim()
        }))
        .filter((segment) => segment.text && segment.end > segment.start);
    });

    const segments = results.flat().sort((a, b) => a.start - b.start);
    return {
      source: `${mode === "audioChat" ? "openrouter-audio-chat" : "openrouter-stt"}:${provider.model}`,
      format: mode === "audioChat" ? "application/vnd.openrouter.audio-chat+json" : "application/vnd.openrouter.stt+json",
      language: provider.language,
      text: segments.map((segment) => segment.text).join(" "),
      segments,
      usage: {
        provider: "openrouter",
        model: provider.model,
        seconds: totalSeconds || duration,
        costUsd: Number(totalCost.toFixed(6))
      }
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function transcribeOpenRouterChunk(params: {
  apiKey: string;
  model: string;
  language: string;
  audioBase64: string;
}): Promise<{ text?: string; segments?: TranscriptSegment[]; usage?: { cost?: number; seconds?: number } }> {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let response: Response;
    let body = "";
    try {
      response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          "content-type": "application/json",
          "http-referer": "http://localhost:3729",
          "x-title": "podcast-proxy-v1"
        },
        body: JSON.stringify({
          model: params.model,
          language: params.language,
          temperature: 0,
          input_audio: {
            data: params.audioBase64,
            format: "mp3"
          }
        }),
        signal: controller.signal
      });
      body = await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 5) break;
      await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) {
      return JSON.parse(body) as { text?: string; usage?: { cost?: number; seconds?: number } };
    }
    lastError = `${response.status} ${body}`;
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 5) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1500 * 2 ** attempt);
    await delay(backoffMs + Math.floor(Math.random() * 500));
  }
  throw new Error(`OpenRouter STT failed after retries: ${lastError}`);
}

async function transcribeOpenRouterAudioChatChunk(params: {
  apiKey: string;
  model: string;
  audioBase64: string;
  durationSeconds: number;
  chunkIndex: number;
  chunkCount: number;
}): Promise<{ text?: string; segments?: TranscriptSegment[]; usage?: { cost?: number; seconds?: number } }> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let response: Response;
    let body = "";
    logTranscriptProgress("openrouter audio chat attempt started", {
      model: params.model,
      chunk: params.chunkIndex,
      chunks: params.chunkCount,
      attempt: attempt + 1
    });
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          "content-type": "application/json",
          "http-referer": "http://localhost:3729",
          "x-title": "podcast-proxy-v1"
        },
        body: JSON.stringify({
          model: params.model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "Transcribe this podcast audio clip into timestamped segments.",
                    "Return strict JSON only: {\"segments\":[{\"start\":number,\"end\":number,\"text\":\"...\"}]}",
                    "Timestamps must be seconds from the start of this exact clip.",
                    `Use natural utterance-sized segments, usually 2-8 seconds. The last segment end must not exceed ${params.durationSeconds.toFixed(3)}.`,
                    "Preserve proper nouns, brand names, show names, URLs, and Australian place names."
                  ].join(" ")
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: params.audioBase64,
                    format: "mp3"
                  }
                }
              ]
            }
          ],
          temperature: 0,
          max_tokens: 5000,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });
      body = await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logTranscriptProgress("openrouter audio chat attempt failed", {
        level: 40,
        model: params.model,
        chunk: params.chunkIndex,
        chunks: params.chunkCount,
        attempt: attempt + 1,
        error: lastError
      });
      if (attempt === 2) break;
      await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) {
      try {
        const payload = JSON.parse(body) as {
          id?: string;
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { cost?: number; seconds?: number };
        };
        const segments = parseOpenRouterAudioChatSegments(payload.choices?.[0]?.message?.content ?? "", params.durationSeconds);
        if (segments.length === 0) {
          lastError = `audio chat transcript returned no segments: ${body.slice(0, 500)}`;
          logTranscriptProgress("openrouter audio chat attempt failed", {
            level: 40,
            model: params.model,
            chunk: params.chunkIndex,
            chunks: params.chunkCount,
            attempt: attempt + 1,
            error: "returned no transcript segments"
          });
          if (attempt === 2) break;
          await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
          continue;
        }
        const cost = numberOrUndefined(payload.usage?.cost) ?? (payload.id ? await fetchOpenRouterGenerationCost(params.apiKey, payload.id) : undefined);
        return {
          text: segments.map((segment) => segment.text).join(" "),
          segments,
          usage: {
            cost,
            seconds: params.durationSeconds
          }
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logTranscriptProgress("openrouter audio chat attempt failed", {
          level: 40,
          model: params.model,
          chunk: params.chunkIndex,
          chunks: params.chunkCount,
          attempt: attempt + 1,
          error: lastError
        });
        if (attempt === 2) break;
        await delay(Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500));
        continue;
      }
    }
    lastError = `${response.status} ${body}`;
    logTranscriptProgress("openrouter audio chat attempt failed", {
      level: 40,
      model: params.model,
      chunk: params.chunkIndex,
      chunks: params.chunkCount,
      attempt: attempt + 1,
      error: `${response.status} ${body.slice(0, 500)}`
    });
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1500 * 2 ** attempt);
    await delay(backoffMs + Math.floor(Math.random() * 500));
  }
  throw new Error(`OpenRouter audio chat transcription failed after retries: ${lastError}`);
}

function parseOpenRouterAudioChatSegments(content: string, durationSeconds: number): TranscriptSegment[] {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).segments)
      ? ((parsed as Record<string, unknown>).segments as unknown[])
      : [];
  return entries
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => {
      const start = Math.max(0, Math.min(durationSeconds, Number(entry.start ?? entry.startTime ?? 0)));
      const end = Math.max(start, Math.min(durationSeconds, Number(entry.end ?? entry.endTime ?? start)));
      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        text: stripHtml(textOf(entry.text ?? entry.body ?? entry.content)).trim()
      };
    })
    .filter((segment) => segment.text && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

async function fetchOpenRouterGenerationCost(apiKey: string, generationId: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { data?: { total_cost?: number; usage?: number } };
    return numberOrUndefined(payload.data?.total_cost ?? payload.data?.usage);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function logTranscriptProgress(message: string, details: Record<string, unknown>): void {
  const level = typeof details.level === "number" ? details.level : 30;
  const { level: _level, ...rest } = details;
  console.log(JSON.stringify({ level, time: Date.now(), scope: "transcripts", ...rest, msg: message }));
}

function extractPodcastIndexSegments(value: unknown): TranscriptSegment[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const rawSegments = Array.isArray(record.segments)
    ? record.segments
    : Array.isArray(record.transcript)
      ? record.transcript
      : Array.isArray(record.captions)
        ? record.captions
        : [];
  return rawSegments
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => ({
      start: Number(entry.start ?? entry.startTime ?? entry.from ?? 0),
      end: Number(entry.end ?? entry.endTime ?? entry.to ?? entry.start ?? entry.startTime ?? 0),
      text: stripHtml(textOf(entry.text ?? entry.body ?? entry.content))
    }))
    .filter((segment) => segment.text);
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine duration for ${filePath}`);
  return duration;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
