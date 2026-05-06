import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig, EpisodeManifest } from "./types.js";
import { ensureDir, pathExists, readJson, writeJson } from "./utils.js";

export interface EpisodePaths {
  dir: string;
  manifest: string;
  sourceAudio: string;
  processedAudio: string;
  chaptersJson: string;
  transcriptVtt: string;
  transcriptJson: string;
  jingle: string;
}

export interface PodcastAssetPaths {
  dir: string;
  artwork: string;
  artworkMeta: string;
}

export function podcastDir(config: AppConfig, podcastSlug: string): string {
  return path.join(config.storage.dataDir, "podcasts", podcastSlug);
}

export function podcastAssetPaths(config: AppConfig, podcastSlug: string): PodcastAssetPaths {
  const dir = path.join(podcastDir(config, podcastSlug), "assets");
  return {
    dir,
    artwork: path.join(dir, "artwork-ad-free.png"),
    artworkMeta: path.join(dir, "artwork-ad-free.json")
  };
}

export function episodePaths(config: AppConfig, podcastSlug: string, episodeKey: string): EpisodePaths {
  const dir = path.join(podcastDir(config, podcastSlug), "episodes", episodeKey);
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    sourceAudio: path.join(dir, "source.mp3"),
    processedAudio: path.join(dir, "episode.mp3"),
    chaptersJson: path.join(dir, "chapters.json"),
    transcriptVtt: path.join(dir, "transcript.vtt"),
    transcriptJson: path.join(dir, "transcript.json"),
    jingle: path.join(config.storage.dataDir, "assets", "removed-ad-tone.mp3")
  };
}

export async function readManifest(config: AppConfig, podcastSlug: string, episodeKey: string): Promise<EpisodeManifest | undefined> {
  return readJson<EpisodeManifest>(episodePaths(config, podcastSlug, episodeKey).manifest);
}

export async function writeManifest(config: AppConfig, manifest: EpisodeManifest): Promise<void> {
  await writeJson(episodePaths(config, manifest.podcastSlug, manifest.episodeKey).manifest, manifest);
}

export async function writeEpisodeJson(config: AppConfig, podcastSlug: string, episodeKey: string, name: "chaptersJson" | "transcriptJson", value: unknown): Promise<string> {
  const paths = episodePaths(config, podcastSlug, episodeKey);
  await writeJson(paths[name], value);
  return paths[name];
}

export async function ensureEpisodeDir(config: AppConfig, podcastSlug: string, episodeKey: string): Promise<EpisodePaths> {
  const paths = episodePaths(config, podcastSlug, episodeKey);
  await ensureDir(paths.dir);
  return paths;
}

export async function fileBytes(filePath: string): Promise<number | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return (await readFile(filePath)).byteLength;
}
