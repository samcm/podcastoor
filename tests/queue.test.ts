import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaultConfig, resolvePodcastConfig } from "../src/config.js";
import { isFatalProviderError, listQueueEpisodes, markQueueFailure, markQueueRunning, resetQueueAttempts, shouldProcessQueueEpisode, syncDiscoveredEpisode } from "../src/queue.js";
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

test("provider quota failures wait for credits instead of being quarantined", async () => {
  const config = await testConfig();
  const podcast = resolvePodcastConfig(config, "show");
  const episode = testEpisode();
  const error = new Error(
    'ElevenLabs forced alignment failed after retries: 401 {"detail":{"code":"quota_exceeded","message":"This request exceeds your quota of 40000. You have 138 credits remaining"}}'
  );

  expect(isFatalProviderError(String(error))).toBe(true);

  await syncDiscoveredEpisode(config, podcast, episode);
  for (let i = 0; i < 3; i += 1) {
    await markQueueRunning(config, podcast, episode, "aligning transcript");
    await markQueueFailure(config, podcast, episode, error);
  }

  let [entry] = await listQueueEpisodes(config);
  expect(entry.state).toBe("waiting-for-credits");
  expect(entry.currentStage).toBe("waiting-for-credits");
  expect(entry.attempts).toBe(3);
  expect(entry.nextRetryAt).toBeUndefined();
  expect(entry.history.at(-1)?.provider).toBe("elevenlabs");

  const blocked = await shouldProcessQueueEpisode(config, podcast, episode, { configPath: "config.yaml" }, { providerBlocked: false });
  expect(blocked).toEqual({ process: false, reason: "waiting for credits" });

  const forced = await shouldProcessQueueEpisode(config, podcast, episode, { configPath: "config.yaml", force: true }, { providerBlocked: false });
  expect(forced.process).toBe(true);
});

test("legacy quarantined provider quota rows are surfaced as waiting for credits", async () => {
  const config = await testConfig();
  const error = 'ElevenLabs forced alignment failed after retries: 401 {"detail":{"code":"quota_exceeded","message":"This request exceeds your quota"}}';
  const statePath = path.join(config.storage.dataDir, "queue", "state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-05-31T00:00:00.000Z",
        episodes: {
          "show:episode": {
            id: "show:episode",
            podcastSlug: "show",
            episodeKey: "episode",
            episodeTitle: "Episode",
            state: "quarantined",
            attempts: 6,
            maxAttempts: 3,
            currentStage: "quarantined",
            lastError: error,
            updatedAt: "2026-05-31T00:00:00.000Z",
            createdAt: "2026-05-31T00:00:00.000Z",
            history: []
          }
        },
        manualRequests: []
      },
      null,
      2
    )
  );

  const [entry] = await listQueueEpisodes(config);
  expect(entry.state).toBe("waiting-for-credits");
  expect(entry.currentStage).toBe("waiting-for-credits");
  expect(entry.nextRetryAt).toBeUndefined();
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
