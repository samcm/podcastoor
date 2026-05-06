import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { AppConfig, EpisodeManifest } from "../src/types.js";
import { readManifest, writeManifest } from "../src/storage.js";

describe("storage", () => {
  it("writes and reads manifests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "podcast-proxy-"));
    const config: AppConfig = { ...defaultConfig, storage: { dataDir: dir } };
    const manifest: EpisodeManifest = {
      schemaVersion: 1,
      pipelineVersion: "test",
      processingSignature: "signature",
      podcastSlug: "show",
      podcastName: "Show",
      episodeKey: "episode",
      title: "Episode",
      guid: "episode",
      sourceFingerprint: "fingerprint",
      decisions: [],
      untimedSignals: [],
      chapters: [],
      audio: { status: "dry-run", removedSeconds: 0, jingleInsertedCount: 0 },
      costs: { estimatedUsd: 0, actualUsd: 0, llmCalls: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };
    await writeManifest(config, manifest);
    await expect(readManifest(config, "show", "episode")).resolves.toMatchObject({ title: "Episode" });
    await rm(dir, { recursive: true, force: true });
  });
});
