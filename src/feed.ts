import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { Chapter, EpisodeManifest, FeedTranscriptRef, ParsedEpisode, ParsedFeed } from "./types.js";
import { absoluteUrl, asArray, episodeKey, formatDuration, parseDuration, parseTimestamp, sha1, stripHtml, textOf } from "./utils.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  format: true,
  suppressEmptyNode: true
});

export async function fetchFeed(feedUrl: string): Promise<string> {
  const response = await fetch(feedUrl, {
    headers: {
      "user-agent": "PodcastProxyV1/0.1 (+https://example.local/podcast-proxy)"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch feed ${feedUrl}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const rawDoc = parser.parse(xml) as Record<string, unknown>;
  const rss = getRecord(rawDoc.rss);
  const channel = getRecord(rss.channel);
  const rawItems = asArray(channel.item);
  const episodes = rawItems.map((item) => parseEpisode(item, feedUrl));
  return {
    rawDoc,
    xml,
    feedUrl,
    title: textOf(channel.title),
    episodes
  };
}

function parseEpisode(raw: unknown, feedUrl: string): ParsedEpisode {
  const item = getRecord(raw);
  const enclosure = getRecord(item.enclosure);
  const guid = textOf(item.guid) || textOf(item["omny:clipId"]) || textOf(item.link) || textOf(item.title);
  const title = textOf(item["itunes:title"]) || textOf(item.title) || "Untitled episode";
  const description = stripHtml(textOf(item.description) || textOf(item["content:encoded"]) || textOf(item["itunes:summary"]));
  const pubDateRaw = textOf(item.pubDate);
  const pubDate = pubDateRaw ? new Date(pubDateRaw) : undefined;
  const sourceUrl = textOf(enclosure["@_url"]);
  const sourceFingerprint = sha1([feedUrl, guid, sourceUrl, textOf(enclosure["@_length"]), pubDateRaw].join("|"));

  return {
    raw,
    key: episodeKey(guid || sourceUrl || title),
    guid,
    title,
    description,
    link: textOf(item.link) || undefined,
    pubDate: pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate : undefined,
    durationSeconds: parseDuration(item["itunes:duration"]),
    enclosure: sourceUrl
      ? {
          url: sourceUrl,
          length: Number(textOf(enclosure["@_length"])) || undefined,
          type: textOf(enclosure["@_type"]) || undefined
        }
      : undefined,
    transcripts: parseTranscriptRefs(item),
    chapters: parsePscChapters(item),
    podcastChaptersUrl: absoluteMaybe(textOf(getRecord(item["podcast:chapters"])["@_url"]), feedUrl),
    sourceFingerprint
  };
}

function absoluteMaybe(value: string, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function parseTranscriptRefs(item: Record<string, unknown>): FeedTranscriptRef[] {
  return asArray(item["podcast:transcript"])
    .map((entry) => getRecord(entry))
    .map((entry) => ({
      url: textOf(entry["@_url"]),
      type: textOf(entry["@_type"]),
      language: textOf(entry["@_language"]) || undefined,
      rel: textOf(entry["@_rel"]) || undefined
    }))
    .filter((entry) => entry.url && entry.type);
}

function parsePscChapters(item: Record<string, unknown>): Chapter[] {
  const psc = getRecord(item["psc:chapters"]);
  return asArray(psc["psc:chapter"])
    .map((chapter) => getRecord(chapter))
    .map((chapter) => ({
      startTime: parseTimestamp(textOf(chapter["@_start"])),
      title: textOf(chapter["@_title"]) || "Chapter",
      url: textOf(chapter["@_href"]) || undefined,
      img: textOf(chapter["@_image"]) || undefined
    }))
    .filter((chapter) => chapter.title);
}

export function rewriteFeed(
  parsed: ParsedFeed,
  options: { publicBaseUrl: string; podcastSlug: string; manifests: Map<string, EpisodeManifest>; pipelineVersion?: string }
): string {
  const doc = structuredClone(parsed.rawDoc) as Record<string, unknown>;
  delete doc["?xml"];
  const rss = getRecord(doc.rss);
  rss["@_xmlns:podcast"] ||= "https://podcastindex.org/namespace/1.0";
  rss["@_xmlns:psc"] ||= "http://podlove.org/simple-chapters";
  const channel = getRecord(rss.channel);
  channel.generator = "podcast-proxy-v1";
  const channelTitle = textOf(channel["itunes:title"]) || textOf(channel.title) || parsed.title;
  const adFreeChannelTitle = withAdFreeSuffix(channelTitle || options.podcastSlug);
  channel.title = adFreeChannelTitle;
  if (channel["itunes:title"] || channelTitle) channel["itunes:title"] = adFreeChannelTitle;
  const proxyFeedUrl = absoluteUrl(options.publicBaseUrl, `/feeds/${options.podcastSlug}.xml`);
  channel["itunes:new-feed-url"] = proxyFeedUrl;
  rewriteImageTitle(channel, adFreeChannelTitle);
  rewriteSelfLink(channel, proxyFeedUrl);

  const items = asArray(channel.item)
    .map((rawItem, index) => {
      const episode = parsed.episodes[index];
      if (!episode) return undefined;
      const manifest = options.manifests.get(episode.key);
      if (!isPublishableManifest(episode, manifest, options.pipelineVersion)) return undefined;
      return rewriteEpisodeItem(getRecord(rawItem), episode.key, options, manifest);
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  channel.item = items;

  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}\n`;
}

function isPublishableManifest(episode: ParsedEpisode, manifest: EpisodeManifest | undefined, pipelineVersion?: string): manifest is EpisodeManifest {
  return Boolean(
    manifest &&
      manifest.audio.status === "completed" &&
      manifest.sourceFingerprint === episode.sourceFingerprint &&
      (!pipelineVersion || manifest.pipelineVersion === pipelineVersion)
  );
}

function rewriteSelfLink(channel: Record<string, unknown>, href: string): void {
  const links = asArray(channel["atom:link"]).map((entry) => getRecord(entry));
  const selfLink = links.find((entry) => textOf(entry["@_rel"]) === "self");
  if (selfLink) {
    selfLink["@_href"] = href;
    selfLink["@_type"] = "application/rss+xml";
  } else {
    links.unshift({
      "@_rel": "self",
      "@_type": "application/rss+xml",
      "@_href": href
    });
  }
  channel["atom:link"] = links;
}

function rewriteImageTitle(channel: Record<string, unknown>, title: string): void {
  const image = getRecord(channel.image);
  if (Object.keys(image).length === 0) return;
  image.title = title;
  channel.image = image;
}

function rewriteEpisodeItem(
  item: Record<string, unknown>,
  episodeKeyValue: string,
  options: { publicBaseUrl: string; podcastSlug: string },
  manifest: EpisodeManifest
): Record<string, unknown> {
  const version = assetVersion(manifest);
  const audioUrl = absoluteUrl(options.publicBaseUrl, `/audio/${options.podcastSlug}/${episodeKeyValue}/episode.mp3?v=${version}`);
  const chaptersUrl = absoluteUrl(options.publicBaseUrl, `/assets/${options.podcastSlug}/${episodeKeyValue}/chapters.json?v=${version}`);
  const transcriptUrl = absoluteUrl(options.publicBaseUrl, `/assets/${options.podcastSlug}/${episodeKeyValue}/transcript.vtt?v=${version}`);
  const title = textOf(item["itunes:title"]) || textOf(item.title) || manifest.title;
  const adFreeTitle = withAdFreeSuffix(title);
  item.title = adFreeTitle;
  item["itunes:title"] = adFreeTitle;

  const enclosure = getRecord(item.enclosure);
  enclosure["@_url"] = audioUrl;
  enclosure["@_type"] = "audio/mpeg";
  if (manifest.audio.bytes != null) enclosure["@_length"] = String(manifest.audio.bytes);
  item.enclosure = enclosure;

  for (const mediaContent of asArray(item["media:content"])) {
    const media = getRecord(mediaContent);
    if (textOf(media["@_type"]).startsWith("audio/")) {
      media["@_url"] = audioUrl;
    }
  }

  if (manifest.processedDurationSeconds != null) {
    item["itunes:duration"] = formatDuration(manifest.processedDurationSeconds);
  }

  appendProxyMetadata(item, manifest);

  if (manifest.chapters.length > 0) {
    item["podcast:chapters"] = {
      "@_url": chaptersUrl,
      "@_type": "application/json+chapters"
    };
    item["psc:chapters"] = {
      "psc:chapter": manifest.chapters.map((chapter) => ({
        "@_start": formatPscStart(chapter.startTime),
        "@_title": chapter.title,
        ...(chapter.url ? { "@_href": chapter.url } : {}),
        ...(chapter.img ? { "@_image": chapter.img } : {})
      }))
    };
  }

  if (manifest.transcript?.path) {
    const existing = asArray(item["podcast:transcript"]).filter((entry) => textOf(getRecord(entry)["@_url"]) !== transcriptUrl);
    item["podcast:transcript"] = [
      {
        "@_url": transcriptUrl,
        "@_type": "text/vtt",
        "@_rel": "captions"
      },
      ...existing
    ];
  }

  return item;
}

function assetVersion(manifest: EpisodeManifest): string {
  return encodeURIComponent(`${manifest.pipelineVersion}-${manifest.generatedAt}`);
}

function withAdFreeSuffix(title: string): string {
  return /\(ad free\)$/i.test(title.trim()) ? title : `${title} (Ad Free)`;
}

function appendProxyMetadata(item: Record<string, unknown>, manifest: EpisodeManifest): void {
  const block = buildProxyMetadataBlock(manifest);
  for (const key of ["description", "itunes:summary", "content:encoded"]) {
    const current = textOf(item[key]);
    if (!current) continue;
    const withoutExisting = current.replace(/<hr>\s*<p><strong>Podcast Proxy<\/strong>[\s\S]*$/i, "").trim();
    item[key] = { "#cdata": `${withoutExisting}${block}` };
  }
}

function buildProxyMetadataBlock(manifest: EpisodeManifest): string {
  const sourceDuration = manifest.audio.sourceDurationSeconds ?? manifest.originalDurationSeconds;
  const processedDuration = manifest.processedDurationSeconds ?? manifest.audio.durationSeconds;
  const savedSeconds = sourceDuration != null && processedDuration != null ? Math.max(0, sourceDuration - processedDuration) : undefined;
  const topDecisions = manifest.decisions
    .filter((decision) => decision.action === "remove")
    .slice(0, 8)
    .map((decision) => `<li>${escapeHtml(formatPscStart(decision.start))}-${escapeHtml(formatPscStart(decision.end))}: ${escapeHtml(decision.reason)}</li>`)
    .join("");
  const llmCost = (manifest.llm ?? []).reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
  const llmDetails = (manifest.llm ?? [])
    .map((usage) => `${usage.purpose}: ${usage.model}${usage.costUsd != null ? `, $${usage.costUsd.toFixed(6)}` : ""}`)
    .join("; ");
  return [
    "<hr>",
    "<p><strong>Podcast Proxy</strong></p>",
    "<ul>",
    `<li>Version: Ad Free</li>`,
    `<li>Time saved: ${escapeHtml(savedSeconds == null ? "unknown" : formatDuration(savedSeconds))}</li>`,
    `<li>RSS duration: ${escapeHtml(formatMaybeDuration(manifest.originalDurationSeconds))}</li>`,
    `<li>Source audio: ${escapeHtml(formatMaybeDuration(sourceDuration))}</li>`,
    `<li>Processed audio: ${escapeHtml(formatMaybeDuration(processedDuration))}</li>`,
    `<li>Render mode: ${escapeHtml(manifest.audio.renderMode ?? "unknown")}${manifest.audio.bitrateKbps ? ` (${manifest.audio.bitrateKbps} kbps)` : ""}</li>`,
    `<li>Removed segments: ${manifest.decisions.filter((decision) => decision.action === "remove").length}</li>`,
    `<li>Marker tones: ${manifest.audio.jingleInsertedCount}</li>`,
    `<li>Actual cost: $${manifest.costs.actualUsd.toFixed(6)}</li>`,
    `<li>Transcript: ${escapeHtml(manifest.transcript ? `${manifest.transcript.source} (${manifest.transcript.segmentCount} segments${manifest.transcript.costUsd ? `, $${manifest.transcript.costUsd.toFixed(6)}` : ""})` : "none")}</li>`,
    `<li>LLM: ${escapeHtml(llmDetails || "none")}${llmCost > 0 ? `; total $${llmCost.toFixed(6)}` : ""}</li>`,
    "</ul>",
    topDecisions ? `<p><strong>Removed windows</strong></p><ul>${topDecisions}</ul>` : ""
  ].join("");
}

function formatMaybeDuration(seconds: number | undefined): string {
  return seconds == null ? "unknown" : formatDuration(seconds);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}

function formatPscStart(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
