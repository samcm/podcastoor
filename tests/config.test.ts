import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig, resolvePodcastConfig } from "../src/config.js";

describe("config", () => {
  it("loads sample podcasts and merges global plus podcast-specific rules", async () => {
    const config = await loadConfig("config.example.yaml");
    const circus = resolvePodcastConfig(config, "the-circus");

    expect(circus.name).toBe("The Circus");
    expect(circus.processing.lookbackDays).toBe(7);
    expect(circus.detection.adKeywords).toContain("use code");
    expect(circus.detection.adKeywords).toContain("discount code");
    expect(circus.detection.adKeywords).not.toContain("smith optics");
    expect(circus.categories.muted).toContain("AFL");
    expect(circus.llm.model).toBe("deepseek/deepseek-v4-pro");
    expect(circus.llm.enabled).toBe(true);
    expect(circus.transcripts.preferred).toBe("openRouter");
    expect(circus.transcripts.providers.openRouter.model).toBe("openai/whisper-large-v3-turbo");
    expect("localWhisper" in circus.transcripts.providers).toBe(false);
    expect(config.automation.processOnStartup).toBe(true);
  });

  it("accepts the old Podcastoor config shape for image replacement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "podcastoor-config-"));
    const configPath = path.join(dir, "config.yaml");
    await writeFile(
      configPath,
      `
publicUrl: https://podcastoor.mumblemains.com
dataDir: ./data
podcasts:
  - id: hello-sport
    name: Hello Sport
    rssUrl: https://feeds.acast.com/public/shows/64e7e1ab41e6ea0011d91292
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
    expect(config.server.publicBaseUrl).toBe("https://podcastoor.mumblemains.com");
    expect(config.server.port).toBe(3000);
    expect(config.podcasts["hello-sport"].feedUrl).toContain("feeds.acast.com");
    await rm(dir, { recursive: true, force: true });
  });
});
