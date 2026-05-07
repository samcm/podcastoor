import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { defaultConfig } from "../src/config.js";
import { parseFeed } from "../src/feed.js";
import { PIPELINE_VERSION } from "../src/pipeline.js";
import type { EpisodeManifest } from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server", () => {
  it("serves audio byte ranges for browser seeking", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "podcastoor-server-"));
    const episodeDir = path.join(dataDir, "podcasts", "show", "episodes", "episode");
    await mkdir(episodeDir, { recursive: true });
    await writeFile(path.join(episodeDir, "episode.mp3"), "abcdefghij");

    const app = buildServer({
      ...defaultConfig,
      storage: { dataDir },
      podcasts: {
        show: { name: "Show", feedUrl: "https://example.com/feed.xml" }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/audio/show/episode/episode.mp3",
      headers: { range: "bytes=2-5" }
    });
    await app.close();

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.body).toBe("cdef");
  });

  it("serves alternate feed endpoints with distinct proxy identities", async () => {
    const feedUrl = "https://feeds.example.com/show.xml";
    const feedXml = `<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
        <channel>
          <title>Show</title>
          <atom:link rel="self" href="${feedUrl}" type="application/rss+xml"/>
          <item>
            <title>Episode</title>
            <guid isPermaLink="false">episode-1</guid>
            <pubDate>Tue, 05 May 2026 01:00:00 GMT</pubDate>
            <enclosure url="https://cdn.example.com/episode.mp3" length="1234" type="audio/mpeg"/>
          </item>
        </channel>
      </rss>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(feedXml, { status: 200 }))
    );

    const dataDir = await mkdtemp(path.join(tmpdir(), "podcastoor-feed-alias-"));
    const parsed = parseFeed(feedXml, feedUrl);
    const episode = parsed.episodes[0];
    const episodeDir = path.join(dataDir, "podcasts", "show", "episodes", episode.key);
    await mkdir(episodeDir, { recursive: true });
    const manifest: EpisodeManifest = {
      schemaVersion: 1,
      pipelineVersion: PIPELINE_VERSION,
      processingSignature: "signature",
      podcastSlug: "show",
      podcastName: "Show",
      episodeKey: episode.key,
      title: "Episode",
      guid: "episode-1",
      sourceUrl: "https://cdn.example.com/episode.mp3",
      sourceFingerprint: episode.sourceFingerprint,
      decisions: [],
      untimedSignals: [],
      chapters: [],
      audio: { status: "completed", removedSeconds: 0, jingleInsertedCount: 0, bytes: 2222, durationSeconds: 600 },
      processedDurationSeconds: 600,
      costs: { estimatedUsd: 0, actualUsd: 0, llmCalls: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };
    await writeFile(path.join(episodeDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    const app = buildServer({
      ...defaultConfig,
      server: { ...defaultConfig.server, publicBaseUrl: "http://localhost:3729" },
      storage: { dataDir },
      podcasts: {
        show: { name: "Show", feedUrl }
      }
    });

    const nested = await app.inject({ method: "GET", url: "/feeds/show/ad-free.xml" });
    const flat = await app.inject({ method: "GET", url: "/feeds/show-ad-free.xml" });
    await app.close();

    expect(nested.statusCode).toBe(200);
    expect(nested.body).toContain("Show (Ad Free)");
    expect(nested.body).toContain("http://localhost:3729/feeds/show/ad-free.xml");
    expect(nested.body).toContain(`podcastoor:show:ad-free:${episode.key}`);
    expect(nested.body).not.toContain("episode-1</guid>");
    expect(flat.statusCode).toBe(200);
    expect(flat.body).toContain("http://localhost:3729/feeds/show-ad-free.xml");
    expect(flat.body).toContain(`podcastoor:show-ad-free:${episode.key}`);
  });
});
