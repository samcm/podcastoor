import { describe, expect, it } from "vitest";
import type { EpisodeManifest } from "../src/types.js";
import { parseFeed, rewriteFeed } from "../src/feed.js";

const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:psc="http://podlove.org/simple-chapters" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Sample Show</title>
    <atom:link rel="self" type="application/rss+xml" href="https://feeds.example.com/show.xml"/>
    <itunes:new-feed-url>https://feeds.example.com/show.xml</itunes:new-feed-url>
    <image>
      <url>https://cdn.example.com/art.jpg</url>
      <title>Sample Show</title>
    </image>
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
        <psc:chapter start="00:10:00" title="Main Topic" />
      </psc:chapters>
    </item>
    <item>
      <title>Unprocessed Episode</title>
      <description>Should not appear until processed.</description>
      <guid isPermaLink="false">episode-2</guid>
      <pubDate>Wed, 06 May 2026 01:00:00 GMT</pubDate>
      <itunes:duration>30:00</itunes:duration>
      <enclosure url="https://cdn.example.com/unprocessed.mp3" length="5678" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

describe("feed", () => {
  it("parses top-level feed metadata for UI summaries", () => {
    const parsed = parseFeed(
      `<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0">
        <channel>
          <title>Metadata Show</title>
          <description><![CDATA[<p>Useful show notes for the whole podcast&rsquo;s feed.</p>]]></description>
          <image><url>/cover.jpg</url></image>
        </channel>
      </rss>`,
      "https://feeds.example.com/show.xml"
    );

    expect(parsed.title).toBe("Metadata Show");
    expect(parsed.description).toBe("Useful show notes for the whole podcast's feed.");
    expect(parsed.imageUrl).toBe("https://feeds.example.com/cover.jpg");
    expect(parsed.episodes).toHaveLength(0);
  });

  it("parses episodes and rewrites completed manifests to local assets", () => {
    const parsed = parseFeed(xml, "https://feeds.example.com/show.xml");
    expect(parsed.title).toBe("Sample Show");
    expect(parsed.description).toBeUndefined();
    expect(parsed.imageUrl).toBe("https://cdn.example.com/art.jpg");
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
      costs: { estimatedUsd: 0, actualUsd: 0, llmCalls: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };

    const rewritten = rewriteFeed(parsed, {
      publicBaseUrl: "http://localhost:3729",
      podcastSlug: "sample",
      manifests: new Map([[parsed.episodes[0].key, manifest]]),
      pipelineVersion: "test",
      artworkUrl: "http://localhost:3729/assets/sample/artwork.png?v=1"
    });

    expect(rewritten).toContain("http://localhost:3729/audio/sample/");
    expect(rewritten).toContain("http://localhost:3729/assets/sample/");
    expect(rewritten).toContain("<title>Sample Show (Ad Free)</title>");
    expect(rewritten).toContain('href="http://localhost:3729/feeds/sample.xml"');
    expect(rewritten).toContain("<itunes:new-feed-url>http://localhost:3729/feeds/sample.xml</itunes:new-feed-url>");
    expect(rewritten).toContain("<title>Sample Show (Ad Free)</title>");
    expect(rewritten).toContain("<url>http://localhost:3729/assets/sample/artwork.png?v=1</url>");
    expect(rewritten).toContain('href="http://localhost:3729/assets/sample/artwork.png?v=1"');
    expect(rewritten).toContain("Sample Episode (Ad Free)");
    expect(rewritten).toContain("Podcast Proxy");
    expect(rewritten).toContain("Time saved");
    expect(rewritten).toContain("59:50");
    expect(rewritten).toContain("application/json+chapters");
    expect(rewritten).not.toContain("Unprocessed Episode");
    expect(rewritten).not.toContain("https://cdn.example.com/unprocessed.mp3");
  });

  it("omits stale manifests until the current enclosure is processed", () => {
    const parsed = parseFeed(xml, "https://feeds.example.com/show.xml");
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
      sourceFingerprint: "old-source",
      decisions: [],
      untimedSignals: [],
      chapters: [],
      audio: { status: "completed", removedSeconds: 0, jingleInsertedCount: 0, bytes: 2222, durationSeconds: 3590 },
      processedDurationSeconds: 3590,
      costs: { estimatedUsd: 0, actualUsd: 0, llmCalls: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };

    const rewritten = rewriteFeed(parsed, {
      publicBaseUrl: "http://localhost:3729",
      podcastSlug: "sample",
      manifests: new Map([[parsed.episodes[0].key, manifest]]),
      pipelineVersion: "test"
    });

    expect(rewritten).not.toContain("Sample Episode");
    expect(rewritten).not.toContain("https://cdn.example.com/episode.mp3");
  });

  it("omits manifests from older pipeline versions", () => {
    const parsed = parseFeed(xml, "https://feeds.example.com/show.xml");
    const manifest: EpisodeManifest = {
      schemaVersion: 1,
      pipelineVersion: "old",
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
      chapters: [],
      audio: { status: "completed", removedSeconds: 0, jingleInsertedCount: 0, bytes: 2222, durationSeconds: 3590 },
      processedDurationSeconds: 3590,
      costs: { estimatedUsd: 0, actualUsd: 0, llmCalls: 0, notes: [] },
      generatedAt: new Date(0).toISOString()
    };

    const rewritten = rewriteFeed(parsed, {
      publicBaseUrl: "http://localhost:3729",
      podcastSlug: "sample",
      manifests: new Map([[parsed.episodes[0].key, manifest]]),
      pipelineVersion: "current"
    });

    expect(rewritten).not.toContain("Sample Episode");
    expect(rewritten).not.toContain("https://cdn.example.com/episode.mp3");
  });
});
