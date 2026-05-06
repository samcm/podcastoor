import pino from "pino";
import { createHash } from "node:crypto";
import type { AppConfig, Chapter, EffectivePodcastConfig, EpisodeManifest, LlmUsage, ParsedEpisode, ProcessingOptions, Transcript } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed } from "./feed.js";
import { isRecent } from "./utils.js";
import { ensureEpisodeDir, readManifest, writeManifest } from "./storage.js";
import { acquireTranscript, writeTranscriptArtifacts } from "./transcripts.js";
import { dedupeSegmentDecisions, detectAdSegments } from "./detectors.js";
import { buildChapters, writeChapters } from "./chapters.js";
import { durationAfterEdits, normalizeSegments, remapChapters, removalSegments } from "./timeline.js";
import { renderEpisodeAudio, downloadAudio } from "./audio.js";
import { assertBudget, estimateEpisodeCost, recordCost } from "./costs.js";
import { classifyTranscriptWithOpenRouter, generateChaptersWithOpenRouter } from "./openrouter.js";

export interface ProcessRunSummary {
  processed: number;
  skipped: number;
  failed: number;
  podcasts: Array<{
    slug: string;
    feedTitle: string;
    discovered: number;
    eligible: number;
    processed: number;
    skipped: number;
    failed: number;
  }>;
}

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const PIPELINE_VERSION = "v3-model-only-timed-detection";

export async function processFeeds(options: ProcessingOptions): Promise<ProcessRunSummary> {
  const config = await loadConfig(options.configPath);
  const slugs = options.podcastSlug ? [options.podcastSlug] : Object.keys(config.podcasts);
  const summary: ProcessRunSummary = { processed: 0, skipped: 0, failed: 0, podcasts: [] };

  for (const slug of slugs) {
    const podcast = resolvePodcastConfig(config, slug);
    const result = await processPodcast(config, podcast, options);
    summary.processed += result.processed;
    summary.skipped += result.skipped;
    summary.failed += result.failed;
    summary.podcasts.push(result);
  }

  return summary;
}

async function processPodcast(config: AppConfig, podcast: EffectivePodcastConfig, options: ProcessingOptions): Promise<ProcessRunSummary["podcasts"][number]> {
  logger.info({ podcast: podcast.slug, feedUrl: podcast.feedUrl }, "fetching feed");
  const xml = await fetchFeed(podcast.feedUrl);
  const feed = parseFeed(xml, podcast.feedUrl);
  const maxEpisodes = options.maxEpisodes ?? podcast.processing.maxEpisodesPerRun;
  const eligible = feed.episodes.filter((episode) => isRecent(episode.pubDate, podcast.processing.lookbackDays)).slice(0, maxEpisodes);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const episode of eligible) {
    try {
      const didProcess = await processEpisode(config, podcast, episode, options);
      if (didProcess) processed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      logger.error({ podcast: podcast.slug, episode: episode.title, err: error }, "episode processing failed");
    }
  }

  return {
    slug: podcast.slug,
    feedTitle: feed.title,
    discovered: feed.episodes.length,
    eligible: eligible.length,
    processed,
    skipped,
    failed
  };
}

async function processEpisode(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, options: ProcessingOptions): Promise<boolean> {
  const dryRun = options.dryRun ?? podcast.processing.dryRun;
  const force = options.force ?? podcast.processing.force;
  const downloadEnabled = options.downloadAudio ?? podcast.processing.downloadAudio;
  const existing = await readManifest(config, podcast.slug, episode.key);
  const targetStatus = dryRun || !downloadEnabled ? "dry-run" : "completed";
  const signature = processingSignature(config, podcast, targetStatus);

  if (
    !force &&
    existing?.sourceFingerprint === episode.sourceFingerprint &&
    existing.audio.status === targetStatus &&
    existing.processingSignature === signature
  ) {
    logger.info({ podcast: podcast.slug, episode: episode.title, pipelineVersion: PIPELINE_VERSION }, "episode already processed");
    return false;
  }

  const paths = await ensureEpisodeDir(config, podcast.slug, episode.key);
  let sourceAudioPath: string | undefined;
  const needsAudioForTranscript =
    !dryRun && (podcast.transcripts.providers.openRouter.enabled || podcast.transcripts.providers.openai.enabled) && Boolean(episode.enclosure?.url);
  if (needsAudioForTranscript && episode.enclosure?.url) {
    await assertBudget(config, estimateEpisodeCost(podcast, undefined, episode.durationSeconds).estimatedUsd);
    await downloadAudio(episode.enclosure.url, paths.sourceAudio);
    sourceAudioPath = paths.sourceAudio;
  }

  const transcript = await acquireTranscript(config, podcast, episode, { sourceAudioPath, dryRun });
  const detection = detectAdSegments(episode, transcript, podcast.detection);
  let modelChapters: Chapter[] = [];
  const llmUsage: LlmUsage[] = [];
  if (transcript?.segments.length && podcast.llm.enabled) {
    try {
      const modelDetection = await classifyTranscriptWithOpenRouter(podcast, episode, transcript);
      detection.decisions.push(...modelDetection.decisions);
      detection.untimedSignals.push(...modelDetection.untimedSignals);
      detection.modelNotes = [...(detection.modelNotes ?? []), ...(modelDetection.modelNotes ?? [])];
      modelChapters = modelDetection.chapters ?? [];
      llmUsage.push(...(modelDetection.llmUsage ?? []));
    } catch (error) {
      detection.modelNotes = [...(detection.modelNotes ?? []), `OpenRouter detection failed without model substitution: ${String(error)}`];
      logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "OpenRouter detection failed without model substitution");
    }
  }
  detection.decisions = dedupeSegmentDecisions(detection.decisions);
  const cost = estimateEpisodeCost(podcast, transcript, episode.durationSeconds);
  await assertBudget(config, cost.estimatedUsd);

  const chapterResult = modelChapters.length > 0 ? { chapters: modelChapters, llmUsage: [] } : await buildEpisodeChapters(podcast, episode, transcript);
  llmUsage.push(...chapterResult.llmUsage);
  const baseChapters = chapterResult.chapters;
  const timelineDuration = Math.max(
    episode.durationSeconds ?? 0,
    transcript?.segments.at(-1)?.end ?? 0,
    ...detection.decisions.map((decision) => decision.end)
  );
  const removed = normalizeSegments(removalSegments(detection.decisions, podcast.processing.confidenceThreshold), {
    durationSeconds: timelineDuration || episode.durationSeconds,
    paddingSeconds: podcast.detection.paddingSeconds,
    minSegmentSeconds: podcast.detection.minSegmentSeconds,
    maxSegmentSeconds: podcast.detection.maxSegmentSeconds
  });
  const jingleDuration = config.audio.jingle.enabled ? config.audio.jingle.durationSeconds : 0;
  const chapters = remapChapters(baseChapters, removed, jingleDuration);
  const processedDuration = durationAfterEdits(episode.durationSeconds, removed, jingleDuration);

  const transcriptPath = transcript ? await writeTranscriptArtifacts(config, podcast.slug, episode.key, transcript) : undefined;
  const audio = await renderEpisodeAudio({
    config,
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    sourceUrl: episode.enclosure?.url,
    originalDurationSeconds: episode.durationSeconds,
    decisions: detection.decisions,
    dryRun,
    downloadAudio: downloadEnabled,
    confidenceThreshold: podcast.processing.confidenceThreshold,
    detection: podcast.detection
  });

  const actualUsd = Number(((transcript?.usage?.costUsd ?? 0) + llmUsage.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0)).toFixed(6));
  const actualNotes = llmUsage
    .filter((usage) => usage.costUsd != null)
    .map((usage) => `OpenRouter ${usage.purpose} actual: ${usage.promptTokens ?? "?"} input tokens + ${usage.completionTokens ?? "?"} output tokens on ${usage.model} = $${usage.costUsd!.toFixed(6)}`);

  const manifest: EpisodeManifest = {
    schemaVersion: 1,
    pipelineVersion: PIPELINE_VERSION,
    processingSignature: signature,
    podcastSlug: podcast.slug,
    podcastName: podcast.name,
    episodeKey: episode.key,
    title: episode.title,
    guid: episode.guid,
    sourceUrl: episode.enclosure?.url,
    sourceFingerprint: episode.sourceFingerprint,
    pubDate: episode.pubDate?.toISOString(),
    originalDurationSeconds: episode.durationSeconds,
    processedDurationSeconds: audio.durationSeconds ?? processedDuration,
    decisions: detection.decisions,
    untimedSignals: detection.untimedSignals,
    modelNotes: detection.modelNotes,
    chapters,
    transcript: transcript
      ? {
          source: transcript.source,
          format: transcript.format,
          path: transcriptPath,
          segmentCount: transcript.segments.length,
          model: transcript.usage?.model,
          seconds: transcript.usage?.seconds,
          costUsd: transcript.usage?.costUsd
        }
      : undefined,
    llm: llmUsage,
    audio,
    costs: {
      estimatedUsd: cost.estimatedUsd,
      actualUsd,
      notes: [...cost.notes, ...actualNotes]
    },
    generatedAt: new Date().toISOString()
  };

  await writeChapters(config, manifest);
  await writeManifest(config, manifest);
  await recordCost(config, {
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    estimatedUsd: cost.estimatedUsd,
    actualUsd,
    notes: [...cost.notes, ...actualNotes]
  });
  logger.info(
    {
      podcast: podcast.slug,
      episode: episode.title,
      status: audio.status,
      decisions: detection.decisions.length,
      untimedSignals: detection.untimedSignals.length,
      chapters: chapters.length
    },
    "processed episode"
  );
  return true;
}

function processingSignature(config: AppConfig, podcast: EffectivePodcastConfig, targetStatus: "completed" | "dry-run"): string {
  const payload = {
    pipelineVersion: PIPELINE_VERSION,
    targetStatus,
    confidenceThreshold: podcast.processing.confidenceThreshold,
    transcripts: podcast.transcripts,
    llm: podcast.llm,
    detection: {
      paddingSeconds: podcast.detection.paddingSeconds,
      minSegmentSeconds: podcast.detection.minSegmentSeconds,
      maxSegmentSeconds: podcast.detection.maxSegmentSeconds
    },
    audio: config.audio,
    preserveUnknownSegments: podcast.processing.preserveUnknownSegments,
    categories: podcast.categories
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function buildEpisodeChapters(podcast: EffectivePodcastConfig, episode: ParsedEpisode, transcript: Transcript | undefined): Promise<{ chapters: Chapter[]; llmUsage: LlmUsage[] }> {
  const existing = buildChapters(episode, transcript, podcast.categories);
  if (existing.length > 0 || !podcast.llm.enabled || !transcript) return { chapters: existing, llmUsage: [] };
  try {
    const generated = await generateChaptersWithOpenRouter(podcast, transcript);
    return { chapters: generated.chapters.length > 0 ? generated.chapters : existing, llmUsage: generated.usage ? [generated.usage] : [] };
  } catch (error) {
    logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "OpenRouter chapter generation failed");
    return { chapters: existing, llmUsage: [] };
  }
}
