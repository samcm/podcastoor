import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AppConfig, EpisodeManifest, Transcript } from "./types.js";
import { episodePaths, readManifest } from "./storage.js";
import { pathExists, readJson } from "./utils.js";

const execFileAsync = promisify(execFile);

export interface PodcastSummary {
  slug: string;
  name: string;
  feedUrl: string;
  subscriptionUrl: string;
  manifestCount: number;
  processedCount: number;
  dryRunCount: number;
  latestEpisode?: {
    title: string;
    pubDate?: string;
    status: string;
  };
}

export async function listPodcastSummaries(config: AppConfig): Promise<PodcastSummary[]> {
  return Promise.all(
    Object.entries(config.podcasts).map(async ([slug, podcast]) => {
      const manifests = await listManifests(config, slug);
      const sorted = manifests.sort((a, b) => Date.parse(b.pubDate ?? b.generatedAt) - Date.parse(a.pubDate ?? a.generatedAt));
      return {
        slug,
        name: podcast.name,
        feedUrl: podcast.feedUrl,
        subscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}.xml`,
        manifestCount: manifests.length,
        processedCount: manifests.filter((manifest) => manifest.audio.status === "completed").length,
        dryRunCount: manifests.filter((manifest) => manifest.audio.status === "dry-run").length,
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

export async function getPodcastDeepDive(config: AppConfig, slug: string) {
  const podcast = config.podcasts[slug];
  if (!podcast) return undefined;
  const manifests = await listManifests(config, slug);
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
    lookbackDays: podcast.lookbackDays ?? config.processing.lookbackDays,
    config: {
      processing: config.processing,
      automation: config.automation,
      audio: config.audio,
      detection: config.detection,
      llm: config.llm,
      transcripts: config.transcripts,
      costs: config.costs
    },
    episodes
  };
}

async function enrichEpisodeForUi(config: AppConfig, slug: string, manifest: EpisodeManifest) {
  const paths = episodePaths(config, slug, manifest.episodeKey);
  const sourceExists = await pathExists(paths.sourceAudio);
  const processedExists = await pathExists(paths.processedAudio);
  const transcript = await readJson<Transcript>(paths.transcriptJson);
  return {
    ...manifest,
    ui: {
      sourceAudioUrl: sourceExists ? `/audio/${slug}/${manifest.episodeKey}/source.mp3` : undefined,
      processedAudioUrl: processedExists ? `/audio/${slug}/${manifest.episodeKey}/episode.mp3` : undefined,
      transcriptSegments: transcript?.segments ?? [],
      sourceDurationSeconds: manifest.audio.sourceDurationSeconds ?? (sourceExists ? await probeDuration(paths.sourceAudio) : undefined),
      processedDurationSeconds: manifest.processedDurationSeconds ?? manifest.audio.durationSeconds ?? (processedExists ? await probeDuration(paths.processedAudio) : undefined)
    }
  };
}

async function listManifests(config: AppConfig, slug: string): Promise<EpisodeManifest[]> {
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
