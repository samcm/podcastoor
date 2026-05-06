import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadConfig, resolvePodcastConfig } from "../src/config.js";
import { writeJson } from "../src/utils.js";

test("runtime overrides merge into global and per-podcast effective config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "podcastoor-overrides-"));
  const dataDir = path.join(dir, "data");
  await mkdir(path.join(dataDir, "config"), { recursive: true });
  await writeFile(
    path.join(dir, "config.yaml"),
    `
server:
  host: 0.0.0.0
  port: 3729
  publicBaseUrl: http://localhost:3729
storage:
  dataDir: ./data
podcasts:
  show:
    name: Show
    feedUrl: https://example.com/feed.xml
`,
    "utf8"
  );
  await writeJson(path.join(dataDir, "config", "runtime-overrides.json"), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    global: {
      processing: { confidenceThreshold: 0.81 },
      detection: { paddingSeconds: 1.25 }
    },
    podcasts: {
      show: {
        detection: { minSegmentSeconds: 12 },
        audio: { jingle: { enabled: false } }
      }
    }
  });

  const config = await loadConfig(path.join(dir, "config.yaml"));
  const podcast = resolvePodcastConfig(config, "show");
  expect(config.processing.confidenceThreshold).toBe(0.81);
  expect(podcast.detection.paddingSeconds).toBe(1.25);
  expect(podcast.detection.minSegmentSeconds).toBe(12);
  expect(podcast.audio.jingle.enabled).toBe(false);
});
