import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaultConfig, resolvePodcastConfig } from "../src/config.js";
import { markQueueFailure, markQueueRunning, syncDiscoveredEpisode } from "../src/queue.js";
import { buildDashboard, buildQueueRows } from "../src/viewmodel.js";
import type { AppConfig, ParsedEpisode } from "../src/types.js";

test("dashboard marks quarantined podcast backlog as warning instead of failure", async () => {
  const config = await testConfig();
  const podcast = resolvePodcastConfig(config, "show");

  for (const key of ["episode-a", "episode-b"]) {
    const episode = testEpisode(key);
    await syncDiscoveredEpisode(config, podcast, episode);
    for (let i = 0; i < 3; i += 1) {
      await markQueueRunning(config, podcast, episode, "detect");
      await markQueueFailure(config, podcast, episode, new Error("model failed"));
    }
  }

  const dashboard = await buildDashboard(config);

  expect(dashboard.podcasts[0].quarantined).toBe(2);
  expect(dashboard.podcasts[0].failed).toBe(0);
  expect(dashboard.podcasts[0].status).toBe("warn");
  expect(dashboard.ops.quarantined).toBe(2);
  expect(dashboard.ops.issues).toHaveLength(2);
  expect(dashboard.ops.issues[0]).toMatchObject({
    podcastSlug: "show",
    episodeTitle: expect.stringContaining("Episode episode-"),
    state: "quarantined",
    attempts: 3
  });
});

test("dashboard still marks active failed podcast jobs as failure", async () => {
  const config = await testConfig();
  const podcast = resolvePodcastConfig(config, "show");
  const episode = testEpisode("episode-a");

  await syncDiscoveredEpisode(config, podcast, episode);
  await markQueueRunning(config, podcast, episode, "detect");
  await markQueueFailure(config, podcast, episode, new Error("model failed"));

  const dashboard = await buildDashboard(config);

  expect(dashboard.podcasts[0].failed).toBe(1);
  expect(dashboard.podcasts[0].status).toBe("fail");
  expect(dashboard.ops.failed).toBe(1);
});

test("queue view exposes exact episode identifiers for single-episode retries", async () => {
  const config = await testConfig();
  const podcast = resolvePodcastConfig(config, "show");
  const episode = testEpisode("episode-a");

  await syncDiscoveredEpisode(config, podcast, episode);

  const [row] = await buildQueueRows(config);

  expect(row.id).toBe("show:episode-a");
  expect(row.episodeKey).toBe("episode-a");
  expect(row.title).toBe("Episode episode-a");
  expect(row.currentStage).toBe(row.stage);
});

async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "podcastoor-viewmodel-"));
  return {
    ...structuredClone(defaultConfig),
    storage: { dataDir },
    retry: { maxAttempts: 3, retryDelayMinutes: 1 },
    podcasts: {
      show: {
        name: "Show",
        feedUrl: "https://example.com/feed.xml"
      }
    }
  };
}

function testEpisode(key: string): ParsedEpisode {
  return {
    raw: {},
    key,
    guid: key,
    title: `Episode ${key}`,
    description: "",
    pubDate: new Date("2026-05-06T00:00:00Z"),
    durationSeconds: 120,
    transcripts: [],
    chapters: [],
    sourceFingerprint: `fingerprint-${key}`
  };
}
