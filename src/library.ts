import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AppConfig, EpisodeManifest, Transcript } from "./types.js";
import { fetchFeed, parseFeed } from "./feed.js";
import { episodePaths, podcastAssetPaths, readManifest } from "./storage.js";
import { absoluteUrl, pathExists, readJson } from "./utils.js";
import { resolvePodcastConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface PodcastSummary {
  slug: string;
  name: string;
  feedUrl: string;
  subscriptionUrl: string;
  alternateSubscriptionUrl: string;
  manifestCount: number;
  processedCount: number;
  dryRunCount: number;
  transcriptionModel: string;
  classifierModel: string;
  latestEpisode?: {
    title: string;
    pubDate?: string;
    status: string;
  };
}

export async function listPodcastSummaries(config: AppConfig): Promise<PodcastSummary[]> {
  return Promise.all(
    Object.entries(config.podcasts).map(async ([slug, podcast]) => {
      const effectivePodcast = resolvePodcastConfig(config, slug);
      const manifests = await listManifests(config, slug);
      const sorted = manifests.sort((a, b) => Date.parse(b.pubDate ?? b.generatedAt) - Date.parse(a.pubDate ?? a.generatedAt));
      return {
        slug,
        name: podcast.name,
        feedUrl: podcast.feedUrl,
        subscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}.xml`,
        alternateSubscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}/ad-free.xml`,
        manifestCount: manifests.length,
        processedCount: manifests.filter((manifest) => manifest.audio.status === "completed").length,
        dryRunCount: manifests.filter((manifest) => manifest.audio.status === "dry-run").length,
        transcriptionModel: transcriptionModelLabel(effectivePodcast.transcripts),
        classifierModel: effectivePodcast.llm.enabled ? effectivePodcast.llm.model : "disabled",
        latestEpisode: sorted[0]
          ? {
              title: sorted[0].title,
              pubDate: sorted[0].pubDate,
              status: sorted[0].audio.status
            }
          : undefined
      };
    })
  );
}

function transcriptionModelLabel(config: AppConfig["transcripts"]): string {
  if (config.providers.openRouter.enabled) return config.providers.openRouter.model;
  if (config.providers.openai.enabled) return config.providers.openai.model;
  if (config.providers.pocketCasts.enabled) return "Pocket Casts";
  if (config.providers.feed.enabled) return "feed transcript";
  return "disabled";
}

export async function getPodcastDeepDive(config: AppConfig, slug: string) {
  const podcast = config.podcasts[slug];
  if (!podcast) return undefined;
  const effectivePodcast = resolvePodcastConfig(config, slug);
  const seeded = podcast as unknown as Record<string, unknown>;
  const seededDescription = typeof seeded.description === "string" ? seeded.description : undefined;
  const [manifests, feedMetadata, localArtworkUrl] = await Promise.all([
    listManifests(config, slug),
    seededDescription
      ? Promise.resolve({ title: podcast.name, description: seededDescription, episodeCount: undefined })
      : readPodcastFeedMetadata(effectivePodcast.feedUrl),
    readLocalArtworkUrl(config, slug)
  ]);
  const processedCount = manifests.filter((manifest) => manifest.audio.status === "completed").length;
  const dryRunCount = manifests.filter((manifest) => manifest.audio.status === "dry-run").length;
  const episodes = await Promise.all(
    manifests
      .sort((a, b) => Date.parse(b.pubDate ?? b.generatedAt) - Date.parse(a.pubDate ?? a.generatedAt))
      .map((manifest) => enrichEpisodeForUi(config, slug, manifest))
  );
  return {
    slug,
    name: podcast.name,
    feedUrl: podcast.feedUrl,
    subscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}.xml`,
    alternateSubscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}/ad-free.xml`,
    lookbackDays: podcast.lookbackDays ?? config.processing.lookbackDays,
    host: typeof seeded.host === "string" ? seeded.host : undefined,
    accentColor: typeof seeded.accentColor === "string" ? seeded.accentColor : undefined,
    demo: (seeded.demo as Record<string, unknown> | undefined) ?? undefined,
    metadata: {
      feedTitle: feedMetadata.title,
      description: feedMetadata.description,
      sourceImageUrl: "imageUrl" in feedMetadata ? feedMetadata.imageUrl : undefined,
      localArtworkUrl,
      upstreamEpisodeCount: feedMetadata.episodeCount,
      feedError: "error" in feedMetadata ? feedMetadata.error : undefined,
      manifestCount: manifests.length,
      processedCount,
      dryRunCount,
      transcriptionModel: transcriptionModelLabel(effectivePodcast.transcripts),
      classifierModel: effectivePodcast.llm.enabled ? effectivePodcast.llm.model : "disabled"
    },
    config: {
      processing: config.processing,
      effectiveProcessing: effectivePodcast.processing,
      automation: config.automation,
      audio: effectivePodcast.audio,
      detection: effectivePodcast.detection,
      llm: effectivePodcast.llm,
      transcripts: effectivePodcast.transcripts,
      costs: config.costs
    },
    episodes
  };
}

async function readPodcastFeedMetadata(feedUrl: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  episodeCount?: number;
  error?: string;
}> {
  try {
    const parsed = parseFeed(await fetchFeed(feedUrl), feedUrl);
    return {
      title: parsed.title,
      description: parsed.description,
      imageUrl: parsed.imageUrl,
      episodeCount: parsed.episodes.length
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readLocalArtworkUrl(config: AppConfig, slug: string): Promise<string | undefined> {
  const paths = podcastAssetPaths(config, slug);
  if (!(await pathExists(paths.artwork))) return undefined;
  return absoluteUrl(config.server.publicBaseUrl, `/assets/${slug}/artwork.jpg`);
}

async function enrichEpisodeForUi(config: AppConfig, slug: string, manifest: EpisodeManifest) {
  const paths = episodePaths(config, slug, manifest.episodeKey);
  const sourceExists = await pathExists(paths.sourceAudio);
  const processedExists = await pathExists(paths.processedAudio);
  const transcript = await readJson<Transcript>(paths.transcriptJson);
  return {
    ...manifest,
    ui: {
      sourceAudioUrl: sourceExists ? `/audio/${slug}/${manifest.episodeKey}/source.mp3?v=${assetVersion(manifest)}` : undefined,
      processedAudioUrl: processedExists ? `/audio/${slug}/${manifest.episodeKey}/episode.mp3?v=${assetVersion(manifest)}` : undefined,
      transcriptSegments: transcript?.segments ?? [],
      sourceDurationSeconds: manifest.audio.sourceDurationSeconds ?? (sourceExists ? await probeDuration(paths.sourceAudio) : undefined),
      processedDurationSeconds: manifest.processedDurationSeconds ?? manifest.audio.durationSeconds ?? (processedExists ? await probeDuration(paths.processedAudio) : undefined)
    }
  };
}

function assetVersion(manifest: EpisodeManifest): string {
  return encodeURIComponent(`${manifest.pipelineVersion}-${manifest.generatedAt}`);
}

export async function listManifests(config: AppConfig, slug: string): Promise<EpisodeManifest[]> {
  const base = path.join(config.storage.dataDir, "podcasts", slug, "episodes");
  if (!(await pathExists(base))) return [];
  const entries = await readdir(base, { withFileTypes: true });
  const manifests: EpisodeManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readManifest(config, slug, entry.name);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

async function probeDuration(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : undefined;
  } catch {
    return undefined;
  }
}
