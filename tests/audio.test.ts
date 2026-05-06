import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";
import { renderEpisodeAudio } from "../src/audio.js";
import { pathExists } from "../src/utils.js";

const execFileAsync = promisify(execFile);

describe("audio", () => {
  it("renders a bounded fixture with an ad-removal tone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "podcast-proxy-audio-"));
    const source = path.join(dir, "fixture.mp3");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "96k",
      source
    ]);

    const config: AppConfig = {
      ...defaultConfig,
      storage: { dataDir: path.join(dir, "data") },
      audio: {
        ...defaultConfig.audio,
        jingle: { ...defaultConfig.audio.jingle, durationSeconds: 0.2 }
      }
    };

    const result = await renderEpisodeAudio({
      config,
      podcastSlug: "fixture",
      episodeKey: "episode",
      sourceUrl: pathToFileURL(source).toString(),
      originalDurationSeconds: 3,
      decisions: [
        {
          start: 1,
          end: 2,
          action: "remove",
          confidence: 0.95,
          reason: "fixture",
          source: "manual"
        }
      ],
      dryRun: false,
      downloadAudio: true,
      confidenceThreshold: 0.7,
      detection: { ...defaultConfig.detection, paddingSeconds: 0, minSegmentSeconds: 0.1 }
    });

    expect(result.status).toBe("completed");
    expect(result.removedSeconds).toBe(1);
    expect(result.jingleInsertedCount).toBe(1);
    expect(result.processedPath && (await pathExists(result.processedPath))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 20000);
});
