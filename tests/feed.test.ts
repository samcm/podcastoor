import { describe, expect, it } from "vitest";
import type { EpisodeManifest } from "../src/types.js";
import { parseFeed, rewriteFeed } from "../src/feed.js";

const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:psc="http://podlove.org/simple-chapters" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Sample Show</title>
    <item>
      <title>Sample Episode</title>
      <description>Original episode notes.</description>
      <guid isPermaLink="false">episode-1</guid>
      <pubDate>Tue, 05 May 2026 01:00:00 GMT</pubDate>
      <itunes:duration>1:00:00</itunes:duration>
      <enclosure url="https://cdn.example.com/episode.mp3" length="1234" type="audio/mpeg"/>
      <podcast:transcript url="https://cdn.example.com/t.vtt" type="text/vtt" />
      <psc:chapters>
        <psc:chapter start="00:00:00" title="Start" />
        <psc:chapter start="00:10:00" title="NRL" />
      </psc:chapters>
    </item>
  </channel>
</rss>`;

describe("feed", () => {
  it("parses episodes and rewrites completed manifests to local assets", () => {
    const parsed = parseFeed(xml, "https://feeds.example.com/show.xml");
    expect(parsed.title).toBe("Sample Show");
    expect(parsed.episodes[0].title).toBe("Sample Episode");
    expect(parsed.episodes[0].chapters).toHaveLength(2);

    const manifest: EpisodeManifest = {
      schemaVersion: 1,
      pipelineVersion: "test",
      processingSignature: "signature",
      podcastSlug: "sample",
      podcastName: "Sample Show",
      episodeKey: parsed.episodes[0].key,
      title: "Sample Episode",
      guid: "episode-1",
      sourceUrl: "https://cdn.example.com/episode.mp3",
      sourceFingerprint: parsed.episodes[0].sourceFingerprint,
      decisions: [],
      untimedSignals: [],
      chapters: [{ startTime: 0, title: "Start" }],
      transcript: { source: "test", format: "text/vtt", path: "/tmp/transcript.vtt", segmentCount: 1 },
      audio: { status: "completed", removedSeconds: 0, jingleInsertedCount: 0, bytes: 2222, durationSeconds: 3590 },
      processedDurationSeconds: 3590,
      costs: { estimatedUsd: 0, actualUsd: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };

    const rewritten = rewriteFeed(parsed, {
      publicBaseUrl: "http://localhost:3729",
      podcastSlug: "sample",
      manifests: new Map([[parsed.episodes[0].key, manifest]])
    });

    expect(rewritten).toContain("http://localhost:3729/audio/sample/");
    expect(rewritten).toContain("http://localhost:3729/assets/sample/");
    expect(rewritten).toContain("Sample Episode (Ad Free)");
    expect(rewritten).toContain("Podcast Proxy");
    expect(rewritten).toContain("Time saved");
    expect(rewritten).toContain("59:50");
    expect(rewritten).toContain("application/json+chapters");
  });
});
