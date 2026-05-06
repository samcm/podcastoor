import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaultConfig } from "../src/config.js";
import { recordCost, summarizeCosts } from "../src/costs.js";
import type { AppConfig } from "../src/types.js";

test("cost summary groups spend by podcast, episode, model, and stage", async () => {
  const config = await testConfig();
  await recordCost(config, {
    podcastSlug: "show",
    episodeKey: "episode",
    estimatedUsd: 0.4,
    actualUsd: 0.3,
    llmCalls: 2,
    notes: [
      "OpenRouter transcript actual: 1.0 min on xiaomi/mimo-v2-omni = $0.100000",
      "OpenRouter ad-detection actual: 10 input tokens + 5 output tokens on qwen/qwen3.6-flash = $0.200000"
    ]
  });

  const summary = await summarizeCosts(config);
  expect(summary.actualUsd).toBe(0.3);
  expect(summary.byPodcast[0]).toMatchObject({ podcastSlug: "show", actualUsd: 0.3, episodes: 1 });
  expect(summary.byModel.find((entry) => entry.model === "qwen/qwen3.6-flash")?.actualUsd).toBe(0.2);
  expect(summary.byStage.find((entry) => entry.stage === "transcription")?.actualUsd).toBe(0.1);
});

async function testConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "podcastoor-costs-"));
  return {
    ...structuredClone(defaultConfig),
    storage: { dataDir },
    podcasts: {
      show: {
        name: "Show",
        feedUrl: "https://example.com/feed.xml"
      }
    }
  };
}
