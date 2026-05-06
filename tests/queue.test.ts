import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaultConfig, resolvePodcastConfig } from "../src/config.js";
import { listQueueEpisodes, markQueueFailure, markQueueRunning, resetQueueAttempts, syncDiscoveredEpisode } from "../src/queue.js";
import type { AppConfig, ParsedEpisode } from "../src/types.js";

test("queue tracks attempts, quarantines after max failures, and can reset", async () => {
  const config = await testConfig();
  const podcast = resolvePodcastConfig(config, "show");
  const episode = testEpisode();

  await syncDiscoveredEpisode(config, podcast, episode);
  for (let i = 0; i < 3; i += 1) {
    await markQueueRunning(config, podcast, episode, "model detection");
    await markQueueFailure(config, podcast, episode, new Error("model failed"));
  }

  let [entry] = await listQueueEpisodes(config);
  expect(entry.state).toBe("quarantined");
  expect(entry.attempts).toBe(3);

  const reset = await resetQueueAttempts(config, { allQuarantined: true });
  expect(reset).toBe(1);
  [entry] = await listQueueEpisodes(config);
  expect(entry.state).toBe("queued");
  expect(entry.attempts).toBe(0);
});

async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "podcastoor-queue-"));
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

function testEpisode(): ParsedEpisode {
  return {
    raw: {},
    key: "episode",
    guid: "episode",
    title: "Episode",
    description: "",
    pubDate: new Date("2026-05-06T00:00:00Z"),
    durationSeconds: 120,
    transcripts: [],
    chapters: [],
    sourceFingerprint: "fingerprint"
  };
}
