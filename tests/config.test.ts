import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig, resolvePodcastConfig } from "../src/config.js";

describe("config", () => {
  it("loads generic defaults without deployment-specific podcasts", async () => {
    const config = await loadConfig("config.example.yaml");
    expect(config.podcasts).toEqual({});
    expect(config.categories.preferred).toEqual([]);
    expect(config.categories.muted).toEqual([]);
    expect(config.llm.model).toBe("deepseek/deepseek-v4-pro");
    expect(config.transcripts.providers.openRouter.model).toBe("openai/whisper-large-v3-turbo");
    expect(config.automation.processOnStartup).toBe(true);
  });

  it("merges global plus podcast-specific rules from deployment config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "podcast-proxy-config-"));
    const configPath = path.join(dir, "config.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 0.0.0.0
  port: 3000
  publicBaseUrl: https://podcasts.example.test
storage:
  dataDir: ./data
categories:
  preferred:
    - interviews
  muted:
    - recaps
podcasts:
  example-show:
    name: Example Show
    feedUrl: https://feeds.example.com/example-show.xml
    lookbackDays: 3
    categories:
      muted:
        - mailbag
`
    );

    const config = await loadConfig(configPath);
    const podcast = resolvePodcastConfig(config, "example-show");
    expect(podcast.name).toBe("Example Show");
    expect(podcast.processing.lookbackDays).toBe(3);
    expect(podcast.categories.preferred).toContain("interviews");
    expect(podcast.categories.muted).toContain("mailbag");
    expect(podcast.llm.enabled).toBe(true);
    expect(podcast.transcripts.preferred).toBe("openRouter");
    expect("localWhisper" in podcast.transcripts.providers).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts the old config shape for image replacement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "podcastoor-config-"));
    const configPath = path.join(dir, "config.yaml");
    await writeFile(
      configPath,
      `
publicUrl: https://podcasts.example.test
dataDir: ./data
podcasts:
  - id: example-show
    name: Example Show
    rssUrl: https://feeds.example.com/example-show.xml
    enabled: true
    retentionDays: 7
    processingOptions:
      removeAds: true
      generateChapters: true
      chunkSizeMinutes: 3
      overlapSeconds: 0
`
    );

    const config = await loadConfig(configPath);
    expect(config.server.publicBaseUrl).toBe("https://podcasts.example.test");
    expect(config.server.port).toBe(3000);
    expect(config.podcasts["example-show"].feedUrl).toBe("https://feeds.example.com/example-show.xml");
    await rm(dir, { recursive: true, force: true });
  });
});
