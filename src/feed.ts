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
    description: parseFeedDescription(channel),
    imageUrl: parseFeedImageUrl(channel, feedUrl),
    episodes
  };
}

function parseFeedDescription(channel: Record<string, unknown>): string | undefined {
  const description = stripHtml(textOf(channel.description) || textOf(channel["itunes:summary"]));
  return description || undefined;
}

function parseFeedImageUrl(channel: Record<string, unknown>, feedUrl: string): string | undefined {
  const itunesImage = textOf(getRecord(channel["itunes:image"])["@_href"]);
  const rssImage = textOf(getRecord(channel.image).url);
  return absoluteMaybe(itunesImage || rssImage, feedUrl);
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
  options: {
    publicBaseUrl: string;
    podcastSlug: string;
    manifests: Map<string, EpisodeManifest>;
    pipelineVersion?: string;
    artworkUrl?: string;
    feedPath?: string;
    identityKey?: string;
  }
): string {
  const doc = structuredClone(parsed.rawDoc) as Record<string, unknown>;
  delete doc["?xml"];
  const rss = getRecord(doc.rss);
  rss["@_xmlns:podcast"] ||= "https://podcastindex.org/namespace/1.0";
  rss["@_xmlns:psc"] ||= "http://podlove.org/simple-chapters";
  const channel = getRecord(rss.channel);
  const rawItems = channel.item;
  delete channel.item;
  channel.generator = "podcast-proxy-v1";
  const channelTitle = textOf(channel["itunes:title"]) || textOf(channel.title) || parsed.title;
  const adFreeChannelTitle = withAdFreeSuffix(channelTitle || options.podcastSlug);
  channel.title = adFreeChannelTitle;
  if (channel["itunes:title"] || channelTitle) channel["itunes:title"] = adFreeChannelTitle;
  const identityKey = options.identityKey ?? options.podcastSlug;
  const proxyFeedUrl = absoluteUrl(options.publicBaseUrl, options.feedPath ?? `/feeds/${options.podcastSlug}.xml`);
  channel["itunes:new-feed-url"] = proxyFeedUrl;
  channel["podcast:guid"] = deterministicUuid(`podcastoor:${identityKey}`);
  channel.link = absoluteUrl(options.publicBaseUrl, `/podcasts/${options.podcastSlug}`);
  removeProviderIdentityTags(channel);
  rewriteImageTitle(channel, adFreeChannelTitle);
  if (options.artworkUrl) rewriteArtworkUrl(channel, options.artworkUrl, adFreeChannelTitle);
  rewriteSelfLink(channel, proxyFeedUrl);

  const items = asArray(rawItems)
    .map((rawItem, index) => {
      const episode = parsed.episodes[index];
      if (!episode) return undefined;
      const manifest = options.manifests.get(episode.key);
      if (!isPublishableManifest(episode, manifest)) return undefined;
      return rewriteEpisodeItem(getRecord(rawItem), episode.key, { ...options, identityKey }, manifest);
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  channel.item = items;

  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}\n`;
}

function isPublishableManifest(episode: ParsedEpisode, manifest: EpisodeManifest | undefined): manifest is EpisodeManifest {
  return Boolean(
    manifest &&
      manifest.audio.status === "completed" &&
      manifest.sourceFingerprint === episode.sourceFingerprint
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

function rewriteArtworkUrl(channel: Record<string, unknown>, artworkUrl: string, title: string): void {
  const image = getRecord(channel.image);
  image.url = artworkUrl;
  image.title = title;
  channel.image = image;

  const itunesImage = getRecord(channel["itunes:image"]);
  itunesImage["@_href"] = artworkUrl;
  channel["itunes:image"] = itunesImage;
}

function rewriteEpisodeItem(
  item: Record<string, unknown>,
  episodeKeyValue: string,
  options: { publicBaseUrl: string; podcastSlug: string; artworkUrl?: string; identityKey: string },
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
  item.guid = {
    "@_isPermaLink": "false",
    "#text": `podcastoor:${options.identityKey}:${episodeKeyValue}`
  };
  item.link = absoluteUrl(options.publicBaseUrl, `/podcasts/${options.podcastSlug}#${episodeKeyValue}`);
  removeProviderIdentityTags(item);
  if (options.artworkUrl) {
    const episodeImage = getRecord(item["itunes:image"]);
    episodeImage["@_href"] = options.artworkUrl;
    item["itunes:image"] = episodeImage;
  }

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

function removeProviderIdentityTags(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (/^(acast|omny|megaphone|art19|podtrac|podaccess):/i.test(key)) {
      delete record[key];
    }
  }
}

function assetVersion(manifest: EpisodeManifest): string {
  return encodeURIComponent(`${manifest.pipelineVersion}-${manifest.generatedAt}`);
}

function withAdFreeSuffix(title: string): string {
  return /\(ad free\)$/i.test(title.trim()) ? title : `${title} (Ad Free)`;
}

function deterministicUuid(seed: string): string {
  const hex = sha1(seed).slice(0, 32).padEnd(32, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

function appendProxyMetadata(item: Record<string, unknown>, manifest: EpisodeManifest): void {
  const block = buildProxyMetadataBlock(manifest);
  for (const key of ["description", "itunes:summary", "content:encoded"]) {
    item[key] = { "#cdata": block };
  }
}

function buildProxyMetadataBlock(manifest: EpisodeManifest): string {
  const sourceDuration = manifest.audio.sourceDurationSeconds ?? manifest.originalDurationSeconds;
  const processedDuration = manifest.processedDurationSeconds ?? manifest.audio.durationSeconds;
  const savedSeconds = Math.max(0, manifest.audio.removedSeconds ?? 0);
  const renderedCuts = manifest.renderedCuts ?? manifest.decisions.filter((decision) => decision.action === "remove").map((decision) => ({ start: decision.start, end: decision.end }));
  const removedAds = removedAdList(manifest, renderedCuts);
  const llmCost = (manifest.llm ?? []).reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
  const classifierModels = uniqueStrings((manifest.llm ?? []).map((usage) => compactModelName(usage.model)));
  const transcriptLabel = manifest.transcript ? compactTranscriptLabel(manifest.transcript.source, manifest.transcript.model) : "none";
  const alignmentLabel = manifest.alignment ? `${manifest.alignment.provider}/${compactModelName(manifest.alignment.model)}` : "none";
  const chapters = manifest.chapters
    .slice(0, 10)
    .map((chapter) => `<li>${escapeHtml(formatPscStart(chapter.startTime))} ${escapeHtml(chapter.title)}</li>`)
    .join("");
  return [
    "<p><strong>Podcast Proxy</strong></p>",
    "<ul>",
    `<li>Time saved: ${escapeHtml(savedSeconds == null ? "unknown" : formatDuration(savedSeconds))}</li>`,
    `<li>Duration: ${escapeHtml(formatMaybeDuration(sourceDuration))} -> ${escapeHtml(formatMaybeDuration(processedDuration))}</li>`,
    `<li>Removed windows: ${renderedCuts.length}${manifest.audio.jingleInsertedCount ? `; marker tones: ${manifest.audio.jingleInsertedCount}` : ""}</li>`,
    `<li>Audio: ${escapeHtml(manifest.audio.codec ?? "audio")}${manifest.audio.bitrateKbps ? `, ${manifest.audio.bitrateKbps}kbps` : ""}</li>`,
    `<li>Models: transcript ${escapeHtml(transcriptLabel)}; alignment ${escapeHtml(alignmentLabel)}; detection ${escapeHtml(classifierModels.join(", ") || "none")}</li>`,
    `<li>Cost: actual $${manifest.costs.actualUsd.toFixed(6)}; estimate $${manifest.costs.estimatedUsd.toFixed(6)}; LLM calls ${(manifest.llm ?? []).length}${llmCost > 0 ? `; LLM $${llmCost.toFixed(6)}` : ""}</li>`,
    `<li>Generated: ${escapeHtml(manifest.generatedAt)}</li>`,
    "</ul>",
    removedAds ? `<p><strong>Removed Ads</strong></p><ol>${removedAds}</ol>` : "",
    chapters ? `<p><strong>Chapters</strong></p><ol>${chapters}</ol>` : ""
  ].join("");
}

function removedAdList(manifest: EpisodeManifest, renderedCuts: Array<{ start: number; end: number }>): string {
  return renderedCuts
    .map((cut) => {
      const matching = manifest.decisions.filter((decision) => decision.action === "remove" && rangesOverlap(cut, decision));
      const advertisers = uniqueStrings(matching.map((decision) => decision.advertiser ?? "").filter(Boolean)).slice(0, 3);
      const reasons = uniqueStrings(matching.map((decision) => decision.reason).filter(Boolean).map(compactReason)).slice(0, 3);
      const context = compactRemovedText(matching.map((decision) => decision.text ?? "").filter(Boolean).join(" "));
      const who = advertisers.join("; ") || "Unknown advertiser";
      const what = reasons.join("; ") || "removed audio";
      const duration = formatDuration(Math.max(0, cut.end - cut.start));
      const contextText = context ? ` - ${context}` : "";
      return `<li><strong>${escapeHtml(formatPscStart(cut.start))}-${escapeHtml(formatPscStart(cut.end))}</strong> (${escapeHtml(duration)}): ${escapeHtml(who)} - ${escapeHtml(what)}${escapeHtml(contextText)}</li>`;
    })
    .join("");
}

function rangesOverlap(first: { start: number; end: number }, second: { start: number; end: number }): boolean {
  return first.end > second.start + 0.25 && second.end > first.start + 0.25;
}

function compactReason(reason: string): string {
  return reason
    .replace(/\s*;\s*(content guard|ending ad tail|reviewed).*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function compactRemovedText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  const sentenceEnd = cleaned.slice(0, 180).search(/[.!?](\s|$)/);
  const summary = sentenceEnd >= 40 ? cleaned.slice(0, sentenceEnd + 1) : cleaned.slice(0, 140);
  return summary.length < cleaned.length ? `${summary.replace(/[,\s]+$/, "")}...` : summary;
}

function compactTranscriptLabel(source: string, model: string | undefined): string {
  if (model) return compactModelName(model);
  const match = /:([^+:]+\/[^+]+)/.exec(source);
  return match ? compactModelName(match[1]) : compactModelName(source);
}

function compactModelName(model: string): string {
  return model.split("/").filter(Boolean).at(-1) ?? model;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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
