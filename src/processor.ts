import pino from "pino";
import { createHash } from "node:crypto";
import type { AppConfig, Chapter, EffectivePodcastConfig, EpisodeManifest, LlmUsage, ParsedEpisode, ProcessingOptions, Transcript } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed } from "./feed.js";
import { isRecent, pathExists, readJson } from "./utils.js";
import { ensureEpisodeDir, readManifest, writeManifest } from "./storage.js";
import { acquireTranscript, writeTranscriptArtifacts } from "./transcripts.js";
import { dedupeSegmentDecisions, detectAdSegments } from "./detectors.js";
import { buildChapters, fetchPodcastIndexChapters, normalizeChapters, writeChapters } from "./chapters.js";
import { durationAfterEdits, normalizeSegments, remapChapters, removalSegments, snapOpeningCutToContent } from "./timeline.js";
import { renderEpisodeAudio, downloadAudio } from "./audio.js";
import { assertBudget, estimateAlignmentCost, estimateEpisodeCost, recordCost } from "./costs.js";
import { classifyTranscriptWithTextLlm, generateChaptersWithTextLlm, reviewAlignedCutBoundariesWithTextLlm } from "./openrouter.js";
import { appendActivity } from "./activity.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { ensurePodcastArtwork } from "./artwork.js";
import {
  type AlignmentResult,
  alignmentNeedsSourceAudio,
  alignmentUsesTargetedProvider,
  alignTranscript,
  alignTargetedDecisionWindows,
  expandDecisionsAcrossNonSpeechTransitions,
  extendEndingAdDecisions,
  guardDecisionsAgainstContentLoss,
  refineDecisionsWithAlignedWords
} from "./alignment.js";
import {
  isFatalProviderError,
  claimManualReprocessRequests,
  completeManualReprocessRequests,
  markQueueCompleted,
  markQueueFailure,
  markQueueRunning,
  markQueueStage,
  queueEntriesForManualRetry,
  listQueueEpisodes,
  shouldProcessQueueEpisode,
  type ManualRunPlan,
  type RunGuard
} from "./queue.js";

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
export async function processFeeds(options: ProcessingOptions): Promise<ProcessRunSummary> {
  const config = await loadConfig(options.configPath);
  const slugs = options.podcastSlug ? [options.podcastSlug] : Object.keys(config.podcasts);
  const summary: ProcessRunSummary = { processed: 0, skipped: 0, failed: 0, podcasts: [] };
  const guard: RunGuard = { providerBlocked: false };
  const manualPlan = await claimManualReprocessRequests(config, slugs);
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    message: "Processing run started",
    details: { podcasts: slugs.length, dryRun: options.dryRun, downloadAudio: options.downloadAudio, force: options.force }
  });

  for (const slug of slugs) {
    const podcast = resolvePodcastConfig(config, slug);
    const result = await processPodcast(config, podcast, options, guard, manualPlan);
    summary.processed += result.processed;
    summary.skipped += result.skipped;
    summary.failed += result.failed;
    summary.podcasts.push(result);
  }

  await completeManualReprocessRequests(config, manualPlan.requests.map((request) => request.id));
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    message: "Processing run finished",
    details: { processed: summary.processed, skipped: summary.skipped, failed: summary.failed }
  });
  return summary;
}

async function processPodcast(
  config: AppConfig,
  podcast: EffectivePodcastConfig,
  options: ProcessingOptions,
  guard: RunGuard,
  manualPlan: ManualRunPlan
): Promise<ProcessRunSummary["podcasts"][number]> {
  const dryRun = options.dryRun ?? podcast.processing.dryRun;
  logger.info({ podcast: podcast.slug, feedUrl: podcast.feedUrl }, "fetching feed");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    message: "Fetching feed"
  });
  const xml = await fetchFeed(podcast.feedUrl);
  const feed = parseFeed(xml, podcast.feedUrl);
  const queueEpisodes = await listQueueEpisodes(config);
  const manualEpisodeKeys = manualPlan.episodeKeysByPodcast.get(podcast.slug) ?? new Set<string>();
  const retryEpisodeKeys = manualPlan.failedOnly ? queueEntriesForManualRetry(queueEpisodes, podcast.slug) : new Set<string>();
  const lookbackDays = manualPlan.lookbackDaysFor(podcast.slug, podcast.processing.lookbackDays);
  const maxEpisodes = manualPlan.maxEpisodesFor(podcast.slug, options.maxEpisodes ?? podcast.processing.maxEpisodesPerRun);
  const discoveredEpisodes = options.episodeKey ? feed.episodes.filter((episode) => episode.key === options.episodeKey) : feed.episodes;
  const eligible = discoveredEpisodes
    .filter((episode) => options.episodeKey === episode.key || isRecent(episode.pubDate, lookbackDays) || manualEpisodeKeys.has(episode.key) || retryEpisodeKeys.has(episode.key))
    .slice(0, maxEpisodes);
  logger.info({ podcast: podcast.slug, feedTitle: feed.title, discovered: feed.episodes.length, eligible: eligible.length }, "feed parsed");
  await recordActivity(config, {
    level: "info",
    scope: "worker",
    podcastSlug: podcast.slug,
    message: "Feed parsed",
    details: { feedTitle: feed.title, discovered: feed.episodes.length, eligible: eligible.length }
  });
  if (!dryRun && !options.skipArtwork) {
    try {
      const artwork = await ensurePodcastArtwork(config, podcast.slug, feed);
      if (artwork.status === "generated" || artwork.status === "exists") {
        logger.info({ podcast: podcast.slug, artworkStatus: artwork.status, model: artwork.model }, "podcast artwork ready");
        await recordActivity(config, {
          level: "info",
          scope: "worker",
          podcastSlug: podcast.slug,
          message: "Podcast artwork ready",
          details: { status: artwork.status, model: artwork.model }
        });
      }
    } catch (error) {
      logger.warn({ podcast: podcast.slug, err: error }, "podcast artwork generation failed");
      await recordActivity(config, {
        level: "warn",
        scope: "worker",
        podcastSlug: podcast.slug,
        message: "Podcast artwork generation failed",
        details: { error: String(error) }
      });
    }
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const episode of eligible) {
    try {
      const episodeOptions = { ...options, ...manualPlan.optionsFor(podcast.slug, episode.key) };
      const queueDecision = await shouldProcessQueueEpisode(config, podcast, episode, episodeOptions, guard);
      if (!queueDecision.process) {
        skipped += 1;
        logger.info({ podcast: podcast.slug, episode: episode.title, reason: queueDecision.reason }, "episode skipped by queue policy");
        await recordActivity(config, {
          level: "info",
          scope: "worker",
          podcastSlug: podcast.slug,
          episodeKey: episode.key,
          episodeTitle: episode.title,
          message: "Episode skipped by queue policy",
          details: { reason: queueDecision.reason }
        });
        continue;
      }
      const didProcess = await processEpisode(config, podcast, episode, episodeOptions);
      if (didProcess) processed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      const queueState = await markQueueFailure(config, podcast, episode, error);
      if (isFatalProviderError(String(error))) {
        guard.providerBlocked = true;
        guard.providerBlockReason = String(error);
      }
      logger.error({ podcast: podcast.slug, episode: episode.title, err: error }, "episode processing failed");
      await recordActivity(config, {
        level: "error",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Episode processing failed",
        details: { error: String(error), queueState }
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
  const force = options.force === true || options.fullReprocess === true || podcast.processing.force;
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
    await markQueueCompleted(config, podcast, episode, "already processed");
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
  await markQueueRunning(config, podcast, episode, "starting");
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
  const needsAudioForAlignment = !dryRun && alignmentNeedsSourceAudio(config.alignment) && Boolean(episode.enclosure?.url);
  if ((needsAudioForTranscript || needsAudioForAlignment) && episode.enclosure?.url) {
    await markQueueStage(config, podcast, episode, "downloading audio");
    const preflightTranscriptCost = estimateEpisodeCost(podcast, undefined, episode.durationSeconds);
    const preflightAlignmentCost = estimateAlignmentCost(config.alignment, episode.durationSeconds);
    await assertBudget(config, preflightTranscriptCost.estimatedUsd + preflightAlignmentCost.estimatedUsd);
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
    options.reuseTranscript !== false && !options.fullReprocess && (!existing || existing.sourceFingerprint === episode.sourceFingerprint)
      ? await readJson<Transcript>(paths.transcriptJson)
      : undefined;
  const reusableTranscript = isTranscriptReusable(podcast, reusableTranscriptCandidate, config.alignment.provider) ? reusableTranscriptCandidate : undefined;
  await markQueueStage(config, podcast, episode, reusableTranscript ? "reusing transcript" : "acquiring transcript");
  const transcript =
    reusableTranscript?.text || reusableTranscript?.segments.length
      ? reusableTranscript
      : await acquireTranscript(config, podcast, episode, { sourceAudioPath, dryRun });
  const alignmentAudioPath = sourceAudioPath ?? ((await pathExists(paths.sourceAudio)) ? paths.sourceAudio : undefined);
  const targetedAlignment = alignmentUsesTargetedProvider(config.alignment);
  let alignment: AlignmentResult;
  if (targetedAlignment) {
    if (!transcript || transcript.segments.length === 0) {
      throw new Error("ElevenLabs targeted alignment requires a non-empty transcript");
    }
    alignment = { transcript };
  } else {
    alignment = await alignTranscript(config.alignment, transcript, {
      sourceAudioPath: alignmentAudioPath,
      durationSeconds: episode.durationSeconds
    });
  }
  let alignedTranscript = alignment.transcript;
  logger.info(
    {
      podcast: podcast.slug,
      episode: episode.title,
      transcriptSource: alignedTranscript.source,
      transcriptSegments: alignedTranscript.segments.length,
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
      source: alignedTranscript.source,
      segments: alignedTranscript.segments.length,
      reused: transcript === reusableTranscript
    }
  });
  if (alignment.metadata) {
    await markQueueStage(config, podcast, episode, "aligning transcript");
    await recordActivity(config, {
      level: "info",
      scope: "worker",
      podcastSlug: podcast.slug,
      episodeKey: episode.key,
      episodeTitle: episode.title,
      message: "Transcript aligned",
      details: {
        provider: alignment.metadata.provider,
        model: alignment.metadata.model,
        wordCount: alignment.metadata.wordCount,
        adjustedSegments: alignment.metadata.adjustedSegments,
        maxAdjustmentSeconds: alignment.metadata.maxAdjustmentSeconds,
        costUsd: alignment.metadata.costUsd
      }
    });
  }
  await markQueueStage(config, podcast, episode, "writing transcript");
  let transcriptPath = alignedTranscript ? await writeTranscriptArtifacts(config, podcast.slug, episode.key, alignedTranscript) : undefined;
  const detection = detectAdSegments(episode, alignedTranscript, podcast.detection);
  let modelChapters: Chapter[] = [];
  const llmUsage: LlmUsage[] = [];
  if (alignedTranscript.segments.length && podcast.llm.enabled) {
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
          transcriptSegments: alignedTranscript.segments.length,
          upstreamChapters: episode.chapters.length
        }
      });
      await markQueueStage(config, podcast, episode, "model detection");
      const modelDetection = await classifyTranscriptWithTextLlm(podcast, episode, alignedTranscript);
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
      detection.modelNotes = [...(detection.modelNotes ?? []), `Text LLM detection failed without model substitution: ${String(error)}`];
      logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "Text LLM detection failed without model substitution");
      await recordActivity(config, {
        level: "warn",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Model detection failed",
        details: { error: String(error) }
      });
      throw error;
    }
  }
  if (targetedAlignment) {
    await markQueueStage(config, podcast, episode, "targeted alignment");
    alignment = await alignTargetedDecisionWindows(config.alignment, alignedTranscript, detection.decisions, {
      sourceAudioPath: alignmentAudioPath,
      durationSeconds: episode.durationSeconds,
      confidenceThreshold: 0
    });
    alignedTranscript = alignment.transcript;
    if (alignment.metadata) {
      detection.modelNotes = [
        ...(detection.modelNotes ?? []),
        `Aligned ${alignment.metadata.wordCount ?? 0} words in candidate ad windows with ${alignment.metadata.provider}.`
      ];
      await recordActivity(config, {
        level: "info",
        scope: "worker",
        podcastSlug: podcast.slug,
        episodeKey: episode.key,
        episodeTitle: episode.title,
        message: "Targeted alignment complete",
        details: {
          provider: alignment.metadata.provider,
          model: alignment.metadata.model,
          wordCount: alignment.metadata.wordCount,
          seconds: alignment.metadata.seconds,
          costUsd: alignment.metadata.costUsd
        }
      });
      transcriptPath = await writeTranscriptArtifacts(config, podcast.slug, episode.key, alignedTranscript);
    }
  }
  const refined = refineDecisionsWithAlignedWords(detection.decisions, alignedTranscript);
  detection.decisions = dedupeSegmentDecisions(refined.decisions);
  if (refined.adjustedDecisions > 0) {
    detection.modelNotes = [...(detection.modelNotes ?? []), `Refined ${refined.adjustedDecisions} ad decision boundaries with forced word timestamps.`];
  }
  const expanded = expandDecisionsAcrossNonSpeechTransitions(detection.decisions, alignedTranscript);
  detection.decisions = dedupeSegmentDecisions(expanded.decisions);
  if (expanded.expandedDecisions > 0) {
    detection.modelNotes = [...(detection.modelNotes ?? []), `Expanded ${expanded.expandedDecisions} ad decision boundaries across adjacent non-speech transition audio.`];
  }
  if (alignedTranscript.words?.length && podcast.llm.enabled) {
    await markQueueStage(config, podcast, episode, "boundary review");
    const boundaryReview = await reviewAlignedCutBoundariesWithTextLlm(podcast, episode, alignedTranscript, detection.decisions);
    detection.decisions = dedupeSegmentDecisions(boundaryReview.decisions);
    llmUsage.push(...boundaryReview.llmUsage);
    detection.modelNotes = [...(detection.modelNotes ?? []), ...boundaryReview.notes];
    await recordActivity(config, {
      level: "info",
      scope: "worker",
      podcastSlug: podcast.slug,
      episodeKey: episode.key,
      episodeTitle: episode.title,
      message: "Aligned boundary review complete",
      details: {
        decisions: detection.decisions.length,
        calls: boundaryReview.llmUsage.length,
        model: podcast.llm.model
      }
    });
  }
  const guarded = guardDecisionsAgainstContentLoss(detection.decisions, alignedTranscript);
  detection.decisions = dedupeSegmentDecisions(guarded.decisions);
  if (guarded.guardedBoundaries > 0 || guarded.downgradedDecisions > 0) {
    detection.modelNotes = [
      ...(detection.modelNotes ?? []),
      `Protected content by moving ${guarded.guardedBoundaries} unsafe cut boundaries inward and downgrading ${guarded.downgradedDecisions} unsafe cuts.`
    ];
  }
  const endingExtended = extendEndingAdDecisions(detection.decisions, alignedTranscript);
  detection.decisions = dedupeSegmentDecisions(endingExtended.decisions);
  if (endingExtended.extendedDecisions > 0) {
    detection.modelNotes = [...(detection.modelNotes ?? []), `Extended ${endingExtended.extendedDecisions} approved ending ad cuts to the final transcript boundary after alignment.`];
  }
  await markQueueStage(config, podcast, episode, "estimating cost");
  const textCost = estimateEpisodeCost(podcast, alignedTranscript, episode.durationSeconds);
  const alignmentCost =
    alignment.metadata?.costUsd != null
      ? {
          estimatedUsd: alignment.metadata.costUsd,
          notes: [
            `${alignment.metadata.provider} alignment estimate: ${((alignment.metadata.seconds ?? episode.durationSeconds ?? 0) / 60).toFixed(1)} min x $${config.alignment.estimatedCostPerMinuteUsd}/min on ${alignment.metadata.model}`
          ]
        }
      : estimateAlignmentCost(config.alignment, episode.durationSeconds);
  const cost = {
    estimatedUsd: Number((textCost.estimatedUsd + alignmentCost.estimatedUsd).toFixed(6)),
    notes: [...textCost.notes, ...alignmentCost.notes]
  };
  await assertBudget(config, cost.estimatedUsd);

  const hasUpstreamChapters = episode.chapters.length > 0;
  const chapterResult = hasUpstreamChapters
    ? { chapters: buildChapters(episode, alignedTranscript, podcast.categories), llmUsage: [] }
    : modelChapters.length > 0
      ? { chapters: modelChapters, llmUsage: [] }
      : await buildEpisodeChapters(podcast, episode, alignedTranscript);
  if (hasUpstreamChapters) {
    detection.modelNotes = [...(detection.modelNotes ?? []), `Preserved ${episode.chapters.length} upstream chapters and remapped them after edits.`];
  }
  llmUsage.push(...chapterResult.llmUsage);
  const baseChapters = chapterResult.chapters;
  const timelineDuration = Math.max(
    episode.durationSeconds ?? 0,
    alignedTranscript.segments.at(-1)?.end ?? 0,
    ...detection.decisions.map((decision) => decision.end)
  );
  const normalizedRemoved = normalizeSegments(removalSegments(detection.decisions, podcast.processing.confidenceThreshold), {
    durationSeconds: timelineDuration || episode.durationSeconds,
    paddingSeconds: podcast.detection.paddingSeconds,
    prePaddingSeconds: podcast.detection.prePaddingSeconds,
    postPaddingSeconds: podcast.detection.postPaddingSeconds,
    minSegmentSeconds: podcast.detection.minSegmentSeconds,
    maxSegmentSeconds: podcast.detection.maxSegmentSeconds
  });
  const removed = snapOpeningCutToContent(normalizedRemoved, alignedTranscript.segments, {
    durationSeconds: timelineDuration || episode.durationSeconds
  });
  const jingleDuration = podcast.audio.jingle.enabled ? podcast.audio.jingle.durationSeconds : 0;
  const chapters = normalizeChapters(remapChapters(baseChapters, removed, jingleDuration, timelineDuration || episode.durationSeconds));
  const processedDuration = durationAfterEdits(timelineDuration || episode.durationSeconds, removed, jingleDuration);

  await markQueueStage(config, podcast, episode, "rendering audio");
  const audio = await renderEpisodeAudio({
    config: { ...config, audio: podcast.audio },
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    sourceUrl: episode.enclosure?.url,
    originalDurationSeconds: episode.durationSeconds,
    decisions: detection.decisions,
    dryRun,
    downloadAudio: downloadEnabled,
    confidenceThreshold: podcast.processing.confidenceThreshold,
    detection: podcast.detection,
    renderedCuts: removed
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

  await markQueueStage(config, podcast, episode, "writing manifest");
  const alignmentActualUsd = alignment.metadata?.costUsd ?? 0;
  const actualUsd = Number(((alignedTranscript.usage?.costUsd ?? 0) + alignmentActualUsd + llmUsage.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0)).toFixed(6));
  const actualNotes = llmUsage
    .filter((usage) => usage.costUsd != null)
    .map((usage) => `${llmProviderLabel(usage.provider)} ${usage.purpose} actual: ${usage.promptTokens ?? "?"} input tokens + ${usage.completionTokens ?? "?"} output tokens on ${usage.model} = $${usage.costUsd!.toFixed(6)}`);
  const alignmentActualNotes =
    alignment.metadata?.costUsd != null
      ? [
          `${alignment.metadata.provider} alignment actual: ${((alignment.metadata.seconds ?? episode.durationSeconds ?? 0) / 60).toFixed(1)} min on ${alignment.metadata.model} = $${alignment.metadata.costUsd.toFixed(6)}`
        ]
      : [];

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
    renderedCuts: audio.renderedCuts ?? removed,
    untimedSignals: detection.untimedSignals,
    modelNotes: detection.modelNotes,
    sourceChapters: normalizeChapters(episode.chapters),
    chapters,
    alignment: alignment.metadata,
    transcript: alignedTranscript
      ? {
          source: alignedTranscript.source,
          format: alignedTranscript.format,
          path: transcriptPath,
          segmentCount: alignedTranscript.segments.length,
          model: alignedTranscript.usage?.model,
          seconds: alignedTranscript.usage?.seconds,
          costUsd: alignedTranscript.usage?.costUsd
        }
      : undefined,
    llm: llmUsage,
    audio,
    costs: {
      estimatedUsd: cost.estimatedUsd,
      actualUsd,
      llmCalls: llmUsage.length,
      notes: [...cost.notes, ...alignmentActualNotes, ...actualNotes]
    },
    generatedAt: new Date().toISOString()
  };

  await writeChapters(config, manifest);
  await writeManifest(config, manifest);
  await markQueueCompleted(config, podcast, episode);
  await recordCost(config, {
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    estimatedUsd: cost.estimatedUsd,
    actualUsd,
    llmCalls: llmUsage.length,
    notes: [...cost.notes, ...alignmentActualNotes, ...actualNotes]
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

function llmProviderLabel(provider: LlmUsage["provider"]): string {
  return provider === "openai-compatible" ? "OpenAI-compatible LLM" : "OpenRouter";
}

function processingSignature(config: AppConfig, podcast: EffectivePodcastConfig, targetStatus: "completed" | "dry-run"): string {
  const payload = {
    pipelineVersion: PIPELINE_VERSION,
    targetStatus,
    confidenceThreshold: podcast.processing.confidenceThreshold,
    transcripts: podcast.transcripts,
    alignment: config.alignment,
    llm: podcast.llm,
    detection: {
      paddingSeconds: podcast.detection.paddingSeconds,
      prePaddingSeconds: podcast.detection.prePaddingSeconds,
      postPaddingSeconds: podcast.detection.postPaddingSeconds,
      minSegmentSeconds: podcast.detection.minSegmentSeconds,
      maxSegmentSeconds: podcast.detection.maxSegmentSeconds
    },
    audio: podcast.audio,
    preserveUnknownSegments: podcast.processing.preserveUnknownSegments,
    categories: podcast.categories
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isTranscriptReusable(podcast: EffectivePodcastConfig, transcript: Transcript | null | undefined, alignmentProvider?: string): transcript is Transcript {
  if (!transcript || (!transcript.text && transcript.segments.length === 0)) return false;
  if (alignmentProvider === "elevenlabs-targeted" && transcript.source.includes("+alignment:elevenlabs-targeted")) return false;
  const transcriptSource = transcript.source.replace(/\+alignment:[^+]+/g, "");
  if (transcriptSource.startsWith("openrouter-stt:") || transcriptSource.startsWith("openrouter-audio-chat:")) {
    const mode = podcast.transcripts.providers.openRouter.mode ?? "stt";
    const expectedSource = `${mode === "audioChat" ? "openrouter-audio-chat" : "openrouter-stt"}:${podcast.transcripts.providers.openRouter.model}`;
    return podcast.transcripts.providers.openRouter.enabled && transcriptSource === expectedSource;
  }
  if (transcriptSource.startsWith("openai:")) {
    return podcast.transcripts.providers.openai.enabled && transcriptSource === `openai:${podcast.transcripts.providers.openai.model}`;
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
  const fallback = buildChapters(episode, transcript, podcast.categories);
  if (!podcast.llm.enabled || !transcript) return { chapters: fallback, llmUsage: [] };
  try {
    const generated = await generateChaptersWithTextLlm(podcast, transcript);
    return { chapters: generated.chapters.length > 0 ? generated.chapters : fallback, llmUsage: generated.usage ? [generated.usage] : [] };
  } catch (error) {
    logger.warn({ podcast: podcast.slug, episode: episode.title, err: error }, "Text LLM chapter generation failed");
    return { chapters: fallback, llmUsage: [] };
  }
}

async function recordActivity(config: AppConfig, event: Parameters<typeof appendActivity>[1]): Promise<void> {
  try {
    await appendActivity(config, event);
  } catch (error) {
    logger.warn({ err: error }, "activity log write failed");
  }
}
