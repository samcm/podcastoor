import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig, EpisodeManifest } from "./types.js";
import { normalizeChapters, writeChapters } from "./chapters.js";
import { episodePaths, readManifest, writeManifest } from "./storage.js";
import { pathExists, readJson } from "./utils.js";
import { dedupeSegmentDecisions, detectAdSegments } from "./detectors.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import type { Transcript } from "./types.js";

const execFileAsync = promisify(execFile);

export interface NormalizeSummary {
  checked: number;
  changed: number;
}

export async function normalizeStoredManifests(config: AppConfig): Promise<NormalizeSummary> {
  let checked = 0;
  let changed = 0;
  for (const slug of Object.keys(config.podcasts)) {
    const podcast = resolvePodcastConfig(config, slug);
    const base = path.join(config.storage.dataDir, "podcasts", slug, "episodes");
    if (!(await pathExists(base))) continue;
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(base, { withFileTypes: true }));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readManifest(config, slug, entry.name);
      if (!manifest) continue;
      checked += 1;
      const paths = episodePaths(config, slug, manifest.episodeKey);
      const before = JSON.stringify({ chapters: manifest.chapters, signals: manifest.untimedSignals, decisions: manifest.decisions, audio: manifest.audio });
      manifest.chapters = normalizeChapters(manifest.chapters);
      if (await pathExists(paths.sourceAudio)) {
        manifest.audio.sourceDurationSeconds = await probeDuration(paths.sourceAudio, manifest.audio.sourceDurationSeconds);
      }
      if (await pathExists(paths.processedAudio)) {
        manifest.audio.durationSeconds = await probeDuration(paths.processedAudio, manifest.audio.durationSeconds);
        manifest.processedDurationSeconds = manifest.audio.durationSeconds;
      }
      if (!manifest.audio.renderMode && manifest.audio.status === "completed") {
        manifest.audio.renderMode = manifest.audio.removedSeconds > 0 ? "encode" : "source-copy";
      }
      const transcript = await readJson<Transcript>(paths.transcriptJson);
      const genericDetection = detectAdSegments(
        {
          raw: {},
          key: manifest.episodeKey,
          guid: manifest.guid,
          title: manifest.title,
          description: "",
          transcripts: [],
          chapters: manifest.chapters,
          sourceFingerprint: manifest.sourceFingerprint
        },
        transcript,
        podcast.detection
      );
      manifest.untimedSignals = genericDetection.untimedSignals;
      manifest.decisions = dedupeSegmentDecisions([
        ...manifest.decisions.filter((decision) => decision.source !== "transcript-rule"),
        ...genericDetection.decisions
      ]);
      const after = JSON.stringify({ chapters: manifest.chapters, signals: manifest.untimedSignals, decisions: manifest.decisions, audio: manifest.audio });
      if (before !== after) {
        await writeManifest(config, manifest as EpisodeManifest);
        await writeChapters(config, manifest as EpisodeManifest);
        changed += 1;
      }
    }
  }
  return { checked, changed };
}

export async function normalizeStoredManifestsFromConfig(configPath: string): Promise<NormalizeSummary> {
  return normalizeStoredManifests(await loadConfig(configPath));
}

async function probeDuration(filePath: string, fallback?: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : fallback;
  } catch {
    return fallback;
  }
}
