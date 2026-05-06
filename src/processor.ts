import pino from "pino";
import { createHash } from "node:crypto";
import type { AppConfig, Chapter, EffectivePodcastConfig, EpisodeManifest, LlmUsage, ParsedEpisode, ProcessingOptions, Transcript } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed } from "./feed.js";
import { isRecent, readJson } from "./utils.js";
import { ensureEpisodeDir, readManifest, writeManifest } from "./storage.js";
import { acquireTranscript, writeTranscriptArtifacts } from "./transcripts.js";
import { dedupeSegmentDecisions, detectAdSegments } from "./detectors.js";
import { buildChapters, fetchPodcastIndexChapters, normalizeChapters, writeChapters } from "./chapters.js";
import { durationAfterEdits, normalizeSegments, remapChapters, removalSegments } from "./timeline.js";
import { renderEpisodeAudio, downloadAudio } from "./audio.js";
import { assertBudget, estimateEpisodeCost, recordCost } from "./costs.js";
import { classifyTranscriptWithOpenRouter, generateChaptersWithOpenRouter } from "./openrouter.js";
import { appendActivity } from "./activity.js";

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
const PIPELINE_VERSION = "v14-absolute-time-ad-detection";

export async function processFeeds(options: ProcessingOptions): Promise<ProcessRunSummary> {
  const config = await loadConfig(options.configPath);
  const slugs = options.podcastSlug ? [options.podcastSlug] : Object.keys(config.podcasts);
  const summary: ProcessRunSummary = { processed: 0, skipped: 0, failed: 0, podcasts: [] };
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    message: "Processing run started",
    details: { podcasts: slugs.length, dryRun: options.dryRun, downloadAudio: options.downloadAudio, force: options.force }
  });

  for (const slug of slugs) {
    const podcast = resolvePodcastConfig(config, slug);
    const result = await processPodcast(config, podcast, options);
    summary.processed += result.processed;
    summary.skipped += result.skipped;
    summary.failed += result.failed;
    summary.podcasts.push(result);
  }

  await recordActivity(config, {
    level: "info",
    scope: "worker",
    message: "Processing run finished",
    details: { processed: summary.processed, skipped: summary.skipped, failed: summary.failed }
  });
  return summary;
}

async function processPodcast(config: AppConfig, podcast: EffectivePodcastConfig, options: ProcessingOptions): Promise<ProcessRunSummary["podcasts"][number]> {
  logger.info({ podcast: podcast.slug, feedUrl: podcast.feedUrl }, "fetching feed");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    message: "Fetching feed"
  });
  const xml = await fetchFeed(podcast.feedUrl);
  const feed = parseFeed(xml, podcast.feedUrl);
  const maxEpisodes = options.maxEpisodes ?? podcast.processing.maxEpisodesPerRun;
  const eligible = feed.episodes.filter((episode) => isRecent(episode.pubDate, podcast.processing.lookbackDays)).slice(0, maxEpisodes);
  logger.info({ podcast: podcast.slug, feedTitle: feed.title, discovered: feed.episodes.length, eligible: eligible.length }, "feed parsed");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    message: "Feed parsed",
    details: { feedTitle: feed.title, discovered: feed.episodes.length, eligible: eligible.length }
  });

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
      await recordActivity(config, {
        level: "error",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Episode processing failed",
        details: { error: String(error) }
      });
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
    await recordActivity(config, {
      level: "info",
      scope: "worker",
      podcastSlug: podcast.slug,
      episodeKey: episode.key,
      episodeTitle: episode.title,
      message: "Episode already processed"
    });
    return false;
  }

  if (episode.chapters.length === 0 && episode.podcastChaptersUrl) {
    try {
      episode.chapters = await fetchPodcastIndexChapters(episode.podcastChaptersUrl);
      logger.info({ podcast: podcast.slug, episode: episode.title, chapters: episode.chapters.length }, "external publisher chapters ready");
      await recordActivity(config, {
        level: "info",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Publisher chapters ready",
        details: { chapters: episode.chapters.length }
      });
    } catch (error) {
      logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "external publisher chapters unavailable");
      await recordActivity(config, {
        level: "warn",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Publisher chapters unavailable",
        details: { error: String(error) }
      });
    }
  }

  const paths = await ensureEpisodeDir(config, podcast.slug, episode.key);
  logger.info({ podcast: podcast.slug, episode: episode.title, targetStatus }, "episode processing started");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    message: "Episode processing started",
    details: { targetStatus, upstreamChapters: episode.chapters.length }
  });
  let sourceAudioPath: string | undefined;
  const needsAudioForTranscript =
    !dryRun && (podcast.transcripts.providers.openRouter.enabled || podcast.transcripts.providers.openai.enabled) && Boolean(episode.enclosure?.url);
  if (needsAudioForTranscript && episode.enclosure?.url) {
    await assertBudget(config, estimateEpisodeCost(podcast, undefined, episode.durationSeconds).estimatedUsd);
    await downloadAudio(episode.enclosure.url, paths.sourceAudio);
    sourceAudioPath = paths.sourceAudio;
    logger.info({ podcast: podcast.slug, episode: episode.title }, "source audio ready");
    await recordActivity(config, {
      level: "info",
      scope: "worker",
      podcastSlug: podcast.slug,
      episodeKey: episode.key,
      episodeTitle: episode.title,
      message: "Source audio ready"
    });
  }

  const reusableTranscriptCandidate =
    existing?.sourceFingerprint === episode.sourceFingerprint ? await readJson<Transcript>(paths.transcriptJson) : undefined;
  const reusableTranscript = isTranscriptReusable(podcast, reusableTranscriptCandidate) ? reusableTranscriptCandidate : undefined;
  const transcript =
    reusableTranscript?.text || reusableTranscript?.segments.length
      ? reusableTranscript
      : await acquireTranscript(config, podcast, episode, { sourceAudioPath, dryRun });
  logger.info(
    {
      podcast: podcast.slug,
      episode: episode.title,
      transcriptSource: transcript?.source,
      transcriptSegments: transcript?.segments.length ?? 0,
      transcriptReused: transcript === reusableTranscript
    },
    "transcript ready"
  );
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    message: "Transcript ready",
    details: {
      source: transcript?.source,
      segments: transcript?.segments.length ?? 0,
      reused: transcript === reusableTranscript
    }
  });
  const detection = detectAdSegments(episode, transcript, podcast.detection);
  let modelChapters: Chapter[] = [];
  const llmUsage: LlmUsage[] = [];
  if (transcript?.segments.length && podcast.llm.enabled) {
    try {
      await recordActivity(config, {
        level: "info",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Model detection started",
        details: {
          model: podcast.llm.model,
          transcriptSegments: transcript.segments.length,
          upstreamChapters: episode.chapters.length
        }
      });
      const modelDetection = await classifyTranscriptWithOpenRouter(podcast, episode, transcript);
      detection.decisions.push(...modelDetection.decisions);
      detection.untimedSignals.push(...modelDetection.untimedSignals);
      detection.modelNotes = [...(detection.modelNotes ?? []), ...(modelDetection.modelNotes ?? [])];
      modelChapters = modelDetection.chapters ?? [];
      llmUsage.push(...(modelDetection.llmUsage ?? []));
      logger.info({ podcast: podcast.slug, episode: episode.title, decisions: modelDetection.decisions.length, chapters: modelDetection.chapters?.length ?? 0 }, "model detection complete");
      await recordActivity(config, {
        level: "info",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Model detection complete",
        details: {
          decisions: modelDetection.decisions.length,
          generatedChapters: modelDetection.chapters?.length ?? 0,
          upstreamChapters: episode.chapters.length
        }
      });
    } catch (error) {
      detection.modelNotes = [...(detection.modelNotes ?? []), `OpenRouter detection failed without model substitution: ${String(error)}`];
      logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "OpenRouter detection failed without model substitution");
      await recordActivity(config, {
        level: "warn",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Model detection failed",
        details: { error: String(error) }
      });
    }
  }
  detection.decisions = dedupeSegmentDecisions(detection.decisions);
  const cost = estimateEpisodeCost(podcast, transcript, episode.durationSeconds);
  await assertBudget(config, cost.estimatedUsd);

  const hasUpstreamChapters = episode.chapters.length > 0;
  const chapterResult = hasUpstreamChapters
    ? { chapters: buildChapters(episode, transcript, podcast.categories), llmUsage: [] }
    : modelChapters.length > 0
      ? { chapters: modelChapters, llmUsage: [] }
      : await buildEpisodeChapters(podcast, episode, transcript);
  if (hasUpstreamChapters) {
    detection.modelNotes = [...(detection.modelNotes ?? []), `Preserved ${episode.chapters.length} upstream chapters and remapped them after edits.`];
  }
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
  const chapters = normalizeChapters(remapChapters(baseChapters, removed, jingleDuration));
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
  logger.info({ podcast: podcast.slug, episode: episode.title, audioStatus: audio.status, removedSeconds: audio.removedSeconds }, "audio render complete");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    message: "Audio render complete",
    details: { status: audio.status, removedSeconds: audio.removedSeconds, durationSeconds: audio.durationSeconds }
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
      llmCalls: llmUsage.length,
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
    llmCalls: llmUsage.length,
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
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    message: "Processed episode",
    details: {
      status: audio.status,
      decisions: detection.decisions.length,
      chapters: chapters.length,
      actualUsd
    }
  });
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

function isTranscriptReusable(podcast: EffectivePodcastConfig, transcript: Transcript | null | undefined): transcript is Transcript {
  if (!transcript || (!transcript.text && transcript.segments.length === 0)) return false;
  if (transcript.source.startsWith("openrouter-stt:") || transcript.source.startsWith("openrouter-audio-chat:")) {
    const mode = podcast.transcripts.providers.openRouter.mode ?? "stt";
    const expectedSource = `${mode === "audioChat" ? "openrouter-audio-chat" : "openrouter-stt"}:${podcast.transcripts.providers.openRouter.model}`;
    return podcast.transcripts.providers.openRouter.enabled && transcript.source === expectedSource;
  }
  if (transcript.source.startsWith("openai:")) {
    return podcast.transcripts.providers.openai.enabled && transcript.source === `openai:${podcast.transcripts.providers.openai.model}`;
  }
  if (transcript.usage?.provider === "openrouter") {
    return podcast.transcripts.providers.openRouter.enabled && transcript.usage.model === podcast.transcripts.providers.openRouter.model;
  }
  if (transcript.usage?.provider === "openai") {
    return podcast.transcripts.providers.openai.enabled && transcript.usage.model === podcast.transcripts.providers.openai.model;
  }
  if (transcript.usage?.provider === "pocketCasts") return podcast.transcripts.providers.pocketCasts.enabled;
  if (transcript.usage?.provider === "feed") return podcast.transcripts.providers.feed.enabled;
  return true;
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

async function recordActivity(config: AppConfig, event: Parameters<typeof appendActivity>[1]): Promise<void> {
  try {
    await appendActivity(config, event);
  } catch (error) {
    logger.warn({ err: error }, "activity log write failed");
  }
}
