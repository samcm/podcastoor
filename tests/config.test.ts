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
});
