import { createWriteStream } from "node:fs";
import { copyFile, rename, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AppConfig, AudioRenderResult, DetectionConfig, SegmentDecision } from "./types.js";
import { ensureDir, pathExists } from "./utils.js";
import { episodePaths, fileBytes } from "./storage.js";
import { keepSegments, normalizeSegments, removalSegments } from "./timeline.js";

const execFileAsync = promisify(execFile);

interface AudioInfo {
  durationSeconds: number;
  codec?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
}

export async function downloadAudio(url: string, destination: string): Promise<void> {
  const completeMarker = `${destination}.complete`;
  if ((await pathExists(destination)) && (await pathExists(completeMarker))) return;
  await ensureDir(path.dirname(destination));
  const temporaryDestination = `${destination}.tmp`;
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), temporaryDestination);
    await rename(temporaryDestination, destination);
    await writeFile(completeMarker, new Date().toISOString(), "utf8");
    return;
  }
  if (path.isAbsolute(url)) {
    await copyFile(url, temporaryDestination);
    await rename(temporaryDestination, destination);
    await writeFile(completeMarker, new Date().toISOString(), "utf8");
    return;
  }
  const response = await fetch(url, { headers: { "user-agent": "PodcastProxyV1/0.1" } });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(temporaryDestination));
  await rename(temporaryDestination, destination);
  await writeFile(completeMarker, new Date().toISOString(), "utf8");
}

export async function renderEpisodeAudio(params: {
  config: AppConfig;
  podcastSlug: string;
  episodeKey: string;
  sourceUrl?: string;
  originalDurationSeconds?: number;
  decisions: SegmentDecision[];
  dryRun: boolean;
  downloadAudio: boolean;
  confidenceThreshold: number;
  detection: DetectionConfig;
}): Promise<AudioRenderResult> {
  const paths = episodePaths(params.config, params.podcastSlug, params.episodeKey);
  const rawRemoved = removalSegments(params.decisions, params.confidenceThreshold);

  if (params.dryRun || !params.downloadAudio) {
    const removed = normalizeSegments(rawRemoved, {
      durationSeconds: params.originalDurationSeconds,
      paddingSeconds: params.detection.paddingSeconds,
      minSegmentSeconds: params.detection.minSegmentSeconds,
      maxSegmentSeconds: params.detection.maxSegmentSeconds
    });
    const removedSeconds = removed.reduce((total, segment) => total + segment.end - segment.start, 0);
    return {
      status: "dry-run",
      removedSeconds,
      jingleInsertedCount: params.config.audio.jingle.enabled ? removed.length : 0,
      sourceDurationSeconds: params.originalDurationSeconds,
      durationSeconds: params.originalDurationSeconds,
      renderMode: "dry-run"
    };
  }

  if (!params.sourceUrl) {
    throw new Error("Cannot render audio without an enclosure URL");
  }

  await downloadAudio(params.sourceUrl, paths.sourceAudio);
  const sourceInfo = await probeAudioInfo(paths.sourceAudio, params.originalDurationSeconds);
  const sourceDuration = sourceInfo.durationSeconds;
  const removed = normalizeSegments(rawRemoved, {
    durationSeconds: sourceDuration,
    paddingSeconds: params.detection.paddingSeconds,
    minSegmentSeconds: params.detection.minSegmentSeconds,
    maxSegmentSeconds: params.detection.maxSegmentSeconds
  });
  const removedSeconds = removed.reduce((total, segment) => total + segment.end - segment.start, 0);
  if (removed.length === 0) {
    await copyFile(paths.sourceAudio, paths.processedAudio);
    return {
      status: "completed",
      sourcePath: paths.sourceAudio,
      processedPath: paths.processedAudio,
      bytes: await fileBytes(paths.processedAudio),
      sourceDurationSeconds: sourceDuration,
      durationSeconds: sourceDuration,
      removedSeconds: 0,
      jingleInsertedCount: 0,
      renderMode: "source-copy",
      codec: sourceInfo.codec,
      bitrateKbps: sourceInfo.bitrateKbps
    };
  }

  await ensureDir(paths.dir);
  const renderMode = params.config.audio.preserveSourceQuality && sourceInfo.codec === "mp3" ? "source-copy" : "encode";
  const outputBitrateKbps = sourceInfo.bitrateKbps ?? params.config.audio.outputBitrateKbps;
  const jinglePath = params.config.audio.jingle.enabled
    ? await ensureJingle(params.config, {
        outputPath: renderMode === "source-copy" ? path.join(paths.dir, "removed-ad-tone.mp3") : undefined,
        bitrateKbps: outputBitrateKbps,
        sampleRate: sourceInfo.sampleRate,
        channels: sourceInfo.channels
      })
    : undefined;
  const pieces: string[] = [];
  const keeps = keepSegments(sourceDuration, removed);
  for (let index = 0; index < keeps.length; index += 1) {
    const keep = keeps[index];
    const piecePath = path.join(paths.dir, `piece-${String(index).padStart(3, "0")}.mp3`);
    await renderKeepSegment(paths.sourceAudio, piecePath, keep, renderMode, {
      bitrateKbps: outputBitrateKbps,
      sampleRate: sourceInfo.sampleRate,
      channels: sourceInfo.channels
    });
    pieces.push(piecePath);
    if (jinglePath && index < keeps.length - 1) pieces.push(jinglePath);
  }

  const listPath = path.join(paths.dir, "concat.txt");
  await writeFile(listPath, pieces.map((piece) => `file '${piece.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", paths.processedAudio]);
  return {
    status: "completed",
    sourcePath: paths.sourceAudio,
    processedPath: paths.processedAudio,
    bytes: await fileBytes(paths.processedAudio),
    sourceDurationSeconds: sourceDuration,
    durationSeconds: await probeDuration(paths.processedAudio),
    removedSeconds,
    jingleInsertedCount: jinglePath ? Math.max(0, pieces.filter((piece) => piece === jinglePath).length) : 0,
    renderMode,
    codec: sourceInfo.codec,
    bitrateKbps: outputBitrateKbps
  };
}

async function renderKeepSegment(
  sourcePath: string,
  piecePath: string,
  keep: { start: number; end: number },
  renderMode: "source-copy" | "encode",
  options: { bitrateKbps: number; sampleRate?: number; channels?: number }
): Promise<void> {
  const common = ["-y", "-ss", String(keep.start), "-t", String(keep.end - keep.start), "-i", sourcePath, "-vn"];
  if (renderMode === "source-copy") {
    await runFfmpeg([...common, "-acodec", "copy", piecePath]);
    return;
  }

  await runFfmpeg([
    ...common,
    ...(options.sampleRate ? ["-ar", String(options.sampleRate)] : []),
    ...(options.channels ? ["-ac", String(options.channels)] : []),
    "-acodec",
    "libmp3lame",
    "-b:a",
    `${options.bitrateKbps}k`,
    piecePath
  ]);
}

async function probeDuration(filePath: string, fallback?: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    const parsed = Number(stdout.trim());
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // Fall through to feed duration if ffprobe cannot read the file.
  }
  if (fallback != null) return fallback;
  throw new Error(`Could not determine duration for ${filePath}`);
}

async function probeAudioInfo(filePath: string, fallbackDuration?: number): Promise<AudioInfo> {
  const durationSeconds = await probeDuration(filePath, fallbackDuration);
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,bit_rate,sample_rate,channels",
      "-of",
      "json",
      filePath
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string; bit_rate?: string; sample_rate?: string; channels?: number }>;
    };
    const stream = parsed.streams?.[0];
    return {
      durationSeconds,
      codec: stream?.codec_name,
      bitrateKbps: stream?.bit_rate ? Math.max(1, Math.round(Number(stream.bit_rate) / 1000)) : undefined,
      sampleRate: stream?.sample_rate ? Number(stream.sample_rate) : undefined,
      channels: stream?.channels
    };
  } catch {
    return { durationSeconds };
  }
}

async function ensureJingle(
  config: AppConfig,
  options: { outputPath?: string; bitrateKbps?: number; sampleRate?: number; channels?: number } = {}
): Promise<string> {
  const jinglePath = options.outputPath ?? episodePaths(config, "_assets", "_tone").jingle;
  if (await pathExists(jinglePath)) return jinglePath;
  await ensureDir(path.dirname(jinglePath));
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${config.audio.jingle.frequencyHz}:duration=${config.audio.jingle.durationSeconds}`,
    "-filter:a",
    `volume=${config.audio.jingle.gainDb}dB`,
    ...(options.sampleRate ? ["-ar", String(options.sampleRate)] : []),
    ...(options.channels ? ["-ac", String(options.channels)] : []),
    "-acodec",
    "libmp3lame",
    "-b:a",
    `${options.bitrateKbps ?? config.audio.outputBitrateKbps}k`,
    jinglePath
  ]);
  return jinglePath;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 });
}
