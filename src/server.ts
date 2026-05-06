import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig, EpisodeManifest } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed, rewriteFeed } from "./feed.js";
import { episodePaths, podcastAssetPaths, readManifest } from "./storage.js";
import { absoluteUrl, pathExists, readJson } from "./utils.js";
import { getAutomationState, startAutomation } from "./automation.js";
import { getPodcastDeepDive, listPodcastSummaries } from "./library.js";
import { mapOriginalToProcessed, normalizeSegments, removalSegments, type Segment } from "./timeline.js";
import { readRecentActivity, type ActivityEvent } from "./activity.js";
import { PIPELINE_VERSION } from "./pipeline.js";

type DeepDive = NonNullable<Awaited<ReturnType<typeof getPodcastDeepDive>>>;
type UiEpisode = DeepDive["episodes"][number];
type DeepDiveConfig = DeepDive["config"];

const feedCache = new Map<string, { expiresAt: number; value?: string; pending?: Promise<string> }>();
const FEED_CACHE_MS = 60_000;

export async function startServer(configPath: string, overrides: { host?: string; port?: number } = {}): Promise<void> {
  const config = await loadConfig(configPath);
  if (overrides.host) config.server.host = overrides.host;
  if (overrides.port) config.server.port = overrides.port;
  const app = buildServer(config);
  if (process.env.PODCAST_PROXY_DISABLE_SERVER_AUTOMATION !== "true") {
    startAutomation(configPath, config);
  }
  await app.listen({ host: config.server.host, port: config.server.port });
}

export function buildServer(config: AppConfig) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/health", async () => ({
    ok: true,
    podcasts: Object.keys(config.podcasts),
    dataDir: config.storage.dataDir,
    automation: getAutomationState()
  }));

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    const [podcasts, activity] = await Promise.all([listPodcastSummaries(config), readRecentActivity(config, 25)]);
    return renderPodcastList(podcasts, getAutomationState(), activity);
  });

  app.get("/podcasts/:podcastSlug", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    const deepDive = await getPodcastDeepDive(config, podcastSlug);
    if (!deepDive) {
      reply.code(404);
      return "Podcast not found";
    }
    reply.type("text/html; charset=utf-8");
    return renderPodcastDeepDive(deepDive, getAutomationState());
  });

  app.get("/api/podcasts", async () => ({
    podcasts: await listPodcastSummaries(config),
    automation: getAutomationState()
  }));

  app.get("/api/activity", async () => ({
    activity: await readRecentActivity(config, 100),
    automation: getAutomationState()
  }));

  app.get("/api/podcasts/:podcastSlug", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    const deepDive = await getPodcastDeepDive(config, podcastSlug);
    if (!deepDive) {
      reply.code(404);
      return { error: "podcast not found" };
    }
    return deepDive;
  });

  app.get("/feeds/:podcastSlug.xml", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    reply.type("application/rss+xml; charset=utf-8");
    return getRewrittenFeed(config, podcastSlug);
  });

  app.get("/audio/:podcastSlug/:episodeKey/episode.mp3", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.processedAudio))) {
      reply.code(404);
      return { error: "processed audio not found", hint: "run `npm run process -- --download-audio --no-dry-run` for this episode" };
    }
    return sendAudioFile(request, reply, paths.processedAudio);
  });

  app.get("/audio/:podcastSlug/:episodeKey/source.mp3", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.sourceAudio))) {
      reply.code(404);
      return { error: "source audio not found" };
    }
    return sendAudioFile(request, reply, paths.sourceAudio);
  });

  app.get("/assets/:podcastSlug/:episodeKey/chapters.json", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.chaptersJson))) {
      reply.code(404);
      return { error: "chapters not found" };
    }
    reply.type("application/json");
    return reply.send(createReadStream(paths.chaptersJson));
  });

  app.get("/assets/:podcastSlug/:episodeKey/transcript.vtt", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.transcriptVtt))) {
      reply.code(404);
      return { error: "transcript not found" };
    }
    reply.type("text/vtt; charset=utf-8");
    return reply.send(createReadStream(paths.transcriptVtt));
  });

  app.get("/assets/:podcastSlug/artwork.png", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    const paths = podcastAssetPaths(config, podcastSlug);
    if (!(await pathExists(paths.artwork))) {
      reply.code(404);
      return { error: "artwork not found" };
    }
    const meta = await readJson<{ outputMimeType?: string }>(paths.artworkMeta);
    reply.type(meta?.outputMimeType || "image/png");
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(paths.artwork));
  });

  app.get("/metrics", async () => {
    const costs = await readJson(path.join(config.storage.dataDir, "usage", "costs.json"));
    return {
      podcasts: Object.keys(config.podcasts).length,
      costs: costs ?? null
    };
  });

  return app;
}

async function sendAudioFile(request: FastifyRequest, reply: FastifyReply, filePath: string) {
  const info = await stat(filePath);
  const range = request.headers.range;
  reply.type("audio/mpeg");
  reply.header("Accept-Ranges", "bytes");
  reply.header("Cache-Control", "no-store");

  if (!range) {
    reply.header("Content-Length", String(info.size));
    return reply.send(createReadStream(filePath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    reply.code(416);
    reply.header("Content-Range", `bytes */${info.size}`);
    return reply.send();
  }

  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;
  if (!startRaw && endRaw) {
    const suffixLength = Number(endRaw);
    start = Math.max(0, info.size - suffixLength);
    end = info.size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : info.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
    reply.code(416);
    reply.header("Content-Range", `bytes */${info.size}`);
    return reply.send();
  }

  end = Math.min(end, info.size - 1);
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${info.size}`);
  reply.header("Content-Length", String(end - start + 1));
  return reply.send(createReadStream(filePath, { start, end }));
}

async function getRewrittenFeed(config: AppConfig, podcastSlug: string): Promise<string> {
  const now = Date.now();
  const cached = feedCache.get(podcastSlug);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.pending) return cached.pending;

  const pending = buildRewrittenFeed(config, podcastSlug).then(
    (value) => {
      feedCache.set(podcastSlug, { value, expiresAt: Date.now() + FEED_CACHE_MS });
      return value;
    },
    (error) => {
      feedCache.delete(podcastSlug);
      throw error;
    }
  );
  feedCache.set(podcastSlug, { pending, expiresAt: now + FEED_CACHE_MS });
  return pending;
}

async function buildRewrittenFeed(config: AppConfig, podcastSlug: string): Promise<string> {
  const podcast = resolvePodcastConfig(config, podcastSlug);
  const xml = await fetchFeed(podcast.feedUrl);
  const parsed = parseFeed(xml, podcast.feedUrl);
  const manifests = new Map<string, EpisodeManifest>();
  for (const episode of parsed.episodes) {
    const manifest = await readManifest(config, podcastSlug, episode.key);
    if (manifest) manifests.set(episode.key, manifest);
  }
  const artworkUrl = await localArtworkUrl(config, podcastSlug);
  return rewriteFeed(parsed, {
    publicBaseUrl: config.server.publicBaseUrl,
    podcastSlug,
    manifests,
    pipelineVersion: PIPELINE_VERSION,
    artworkUrl
  });
}

async function localArtworkUrl(config: AppConfig, podcastSlug: string): Promise<string | undefined> {
  const paths = podcastAssetPaths(config, podcastSlug);
  if (!(await pathExists(paths.artwork))) return undefined;
  const info = await stat(paths.artwork);
  return absoluteUrl(config.server.publicBaseUrl, `/assets/${podcastSlug}/artwork.png?v=${encodeURIComponent(String(Math.floor(info.mtimeMs)))}`);
}

function renderPodcastList(
  podcasts: Awaited<ReturnType<typeof listPodcastSummaries>>,
  automation: ReturnType<typeof getAutomationState>,
  activity: ActivityEvent[]
): string {
  return page(
    "Podcast Proxy",
    `<header>
      <h1>Podcast Proxy</h1>
      <p>${automation.running ? "Processing is running" : "Processing is idle"}${automation.lastFinishedAt ? ` · last finished ${escapeHtml(automation.lastFinishedAt)}` : ""}</p>
      <p>Autonomous mode is enabled when configured: process on startup, then repeat on the configured interval.</p>
    </header>
    ${renderActivityLog(activity)}
    <main class="panel">
      <table>
        <thead><tr><th>Podcast</th><th>Manifests</th><th>Rendered</th><th>Latest</th><th>Feed</th></tr></thead>
        <tbody>
          ${podcasts
            .map(
              (podcast) => `<tr>
                <td><a href="/podcasts/${podcast.slug}">${escapeHtml(podcast.name)}</a></td>
                <td>${podcast.manifestCount}</td>
                <td>${podcast.processedCount}</td>
                <td>${podcast.latestEpisode ? escapeHtml(podcast.latestEpisode.title) : "None yet"}</td>
                <td><a href="/feeds/${podcast.slug}.xml">RSS</a></td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </main>`
  );
}

function renderActivityLog(activity: ActivityEvent[]): string {
  const rows = activity.length
    ? activity
        .map(
          (event) => `<li class="${escapeHtml(event.level)}">
            <time>${escapeHtml(formatActivityTime(event.at))}</time>
            <strong>${escapeHtml(event.message)}</strong>
            ${event.podcastSlug ? `<span>${escapeHtml(event.podcastSlug)}</span>` : ""}
            ${event.episodeTitle ? `<em>${escapeHtml(event.episodeTitle)}</em>` : ""}
            ${event.details ? `<code>${escapeHtml(formatActivityDetails(event.details))}</code>` : ""}
          </li>`
        )
        .join("")
    : `<li><span>No worker activity recorded yet.</span></li>`;
  return `<section class="panel activity">
    <div class="section-head"><h2>Worker Activity</h2><a href="/api/activity">JSON</a></div>
    <ol>${rows}</ol>
  </section>`;
}

function renderPodcastDeepDive(deepDive: DeepDive, automation: ReturnType<typeof getAutomationState>): string {
  return page(
    deepDive.name,
    `<header>
      <a href="/">Back</a>
      <h1>${escapeHtml(deepDive.name)}</h1>
      <p>${escapeHtml(deepDive.feedUrl)}</p>
    </header>
    <section class="panel meta">
      <div><span>Subscription URL</span><code>${escapeHtml(deepDive.subscriptionUrl)}</code></div>
      <div><span>Lookback</span><strong>${deepDive.lookbackDays} days</strong></div>
      <div><span>Automation</span><strong>${automation.running ? "running" : "idle"} · every ${deepDive.config.automation.intervalMinutes} min</strong></div>
      <div><span>Model</span><strong>${escapeHtml(deepDive.config.llm.enabled ? deepDive.config.llm.model : "disabled")}</strong></div>
      <div><span>Transcription</span><strong>${escapeHtml(transcriptionLabel(deepDive.config.transcripts))}</strong></div>
    </section>
    <main class="episodes">
      ${deepDive.episodes
        .map((episode) => {
          const sourceDuration = episode.ui.sourceDurationSeconds;
          const processedDuration = episode.ui.processedDurationSeconds;
          const transcriptCost = episode.transcript?.costUsd ?? 0;
          const textLlmCost = (episode.llm ?? []).reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
          const transcriptSegments = episode.transcript?.segmentCount ?? episode.ui.transcriptSegments.length;
          return `<article class="episode">
            <div class="episode-head">
              <h2>${escapeHtml(episode.title)}</h2>
              <span>${escapeHtml(episode.audio.status)}</span>
            </div>
            <dl>
              <dt>Published</dt><dd>${escapeHtml(episode.pubDate ?? "unknown")}</dd>
              <dt>RSS Duration</dt><dd>${formatSeconds(episode.originalDurationSeconds)}</dd>
              <dt>Source Audio</dt><dd>${formatSeconds(sourceDuration)}</dd>
              <dt>Processed Audio</dt><dd>${formatSeconds(processedDuration)}</dd>
              <dt>Time Saved</dt><dd>${formatSeconds(timeSaved(sourceDuration, processedDuration))}${episode.audio.jingleInsertedCount ? ` · ${episode.audio.jingleInsertedCount} markers` : ""}</dd>
              <dt>Render</dt><dd>${escapeHtml(renderQualityLabel(episode.audio))}</dd>
              <dt>Decisions</dt><dd>${episode.decisions.length}</dd>
              <dt>Untimed Signals</dt><dd>${episode.untimedSignals.length}</dd>
              <dt>Chapters</dt><dd>${episode.chapters.length}</dd>
              <dt>Total Cost</dt><dd>$${episode.costs.actualUsd.toFixed(6)}</dd>
              <dt>Transcript Cost</dt><dd>$${transcriptCost.toFixed(6)}${transcriptSegments ? ` · ${transcriptSegments} segments` : ""}</dd>
              <dt>Text LLM Cost</dt><dd>$${textLlmCost.toFixed(6)} · ${(episode.llm ?? []).length} calls</dd>
            </dl>
            ${renderAudioCompare(episode)}
            ${renderTimelines(episode, deepDive.config)}
            ${renderDecisionTable(episode, deepDive.config)}
            ${episode.untimedSignals.length ? `<h3>Signals</h3><ul>${episode.untimedSignals.map((signal) => `<li>${escapeHtml(signal)}</li>`).join("")}</ul>` : ""}
            ${renderChapterTable(episode)}
            ${renderTranscript(episode, deepDive.config)}
          </article>`;
        })
        .join("")}
    </main>`
  );
}

function renderAudioCompare(episode: UiEpisode): string {
  if (!episode.ui.sourceAudioUrl && !episode.ui.processedAudioUrl) return "";
  return `<section class="compare">
    ${episode.ui.sourceAudioUrl ? `<div><h3>Original Download</h3><audio data-role="source-audio" controls preload="none" src="${episode.ui.sourceAudioUrl}"></audio></div>` : ""}
    ${episode.ui.processedAudioUrl ? `<div><h3>Processed</h3><audio data-role="processed-audio" controls preload="none" src="${episode.ui.processedAudioUrl}"></audio></div>` : ""}
  </section>`;
}

function renderTimelines(episode: UiEpisode, config: DeepDiveConfig): string {
  const sourceDuration = Math.max(episode.ui.sourceDurationSeconds ?? 0, ...episode.decisions.map((decision) => decision.end), episode.originalDurationSeconds ?? 0);
  const processedDuration = episode.ui.processedDurationSeconds;
  if (!sourceDuration && !processedDuration) return "";
  const removals = actualRemovalWindows(episode, sourceDuration, config);
  const jingleDuration = config.audio.jingle.enabled ? config.audio.jingle.durationSeconds : 0;
  const annotations = removals
    .map(
      (removal, index) => `<li>
        <button data-jump-source="${removal.start.toFixed(3)}">Source ${formatSeconds(removal.start)}</button>
        <button data-jump-processed="${mapOriginalToProcessed(removal.start, removals, jingleDuration).toFixed(3)}">Processed splice</button>
        <span>${index + 1}. ${escapeHtml(labelsForWindow(episode, removal).map(compactReason).join("; "))}</span>
        <small>${formatSeconds(removal.end - removal.start)} removed</small>
      </li>`
    )
    .join("");
  const sourceCuts = removals
    .map((removal) => {
      const left = Math.max(0, Math.min(100, (removal.start / sourceDuration) * 100));
      const width = Math.max(0.4, Math.min(100 - left, ((removal.end - removal.start) / sourceDuration) * 100));
      const label = `${formatSeconds(removal.start)}-${formatSeconds(removal.end)} ${labelsForWindow(episode, removal).join("; ")}`;
      return `<span class="cut" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHtml(label)}"></span>`;
    })
    .join("");
  const processedChapters = processedDuration
    ? episode.chapters
        .map((chapter) => {
          const left = Math.max(0, Math.min(100, (chapter.startTime / processedDuration) * 100));
          return `<span class="tick" style="left:${left.toFixed(3)}%" title="${escapeHtml(`${formatSeconds(chapter.startTime)} ${chapter.title}`)}"></span>`;
        })
        .join("")
    : "";
  const splices = processedDuration
    ? removals
        .map((removal) => {
          const splice = mapOriginalToProcessed(removal.start, removals, jingleDuration);
          const left = Math.max(0, Math.min(100, (splice / processedDuration) * 100));
          return `<span class="splice" style="left:${left.toFixed(3)}%" title="${escapeHtml(`splice at ${formatSeconds(splice)}`)}"></span>`;
        })
        .join("")
    : "";

  return `<section class="timeline-block">
    <div class="timeline-head"><h3>Timelines</h3><span>Click anywhere on a bar to seek its audio</span></div>
    <div class="timeline-label"><span>Source cuts</span><strong>${formatSeconds(sourceDuration)}</strong></div>
    <div class="timeline" role="button" tabindex="0" data-timeline-target="source" data-duration="${sourceDuration.toFixed(3)}" title="Click to seek original audio">${sourceCuts}</div>
    ${
      processedDuration
        ? `<div class="timeline-label"><span>Processed chapters</span><strong>${formatSeconds(processedDuration)}</strong></div>
           <div class="timeline processed" role="button" tabindex="0" data-timeline-target="processed" data-duration="${processedDuration.toFixed(3)}" title="Click to seek processed audio">${processedChapters}${splices}</div>`
        : ""
    }
    <div class="legend"><span><i class="red"></i>removed source</span><span><i class="green"></i>chapter</span><span><i class="blue"></i>splice</span></div>
    ${annotations ? `<ol class="cut-list">${annotations}</ol>` : ""}
  </section>`;
}

function renderDecisionTable(episode: UiEpisode, config: DeepDiveConfig): string {
  if (episode.decisions.length === 0) return "";
  const sourceDuration = Math.max(episode.ui.sourceDurationSeconds ?? 0, ...episode.decisions.map((decision) => decision.end), episode.originalDurationSeconds ?? 0);
  const removals = actualRemovalWindows(episode, sourceDuration, config);
  const jingleDuration = config.audio.jingle.enabled ? config.audio.jingle.durationSeconds : 0;
  const rows = [...episode.decisions]
    .sort((a, b) => a.start - b.start)
    .map((decision) => {
      const processedSplice = mapOriginalToProcessed(decision.start, removals, jingleDuration);
      const renderWindow = renderWindowForDecision(decision, removals);
      return `<tr>
        <td><button data-jump-source="${decision.start.toFixed(3)}">${formatSeconds(decision.start)}</button></td>
        <td>${formatSeconds(decision.end)}</td>
        <td>${formatSeconds(decision.end - decision.start)}</td>
        <td>${renderWindow ? `${formatSeconds(renderWindow.start)}-${formatSeconds(renderWindow.end)}` : "not cut"}</td>
        <td><button data-jump-processed="${processedSplice.toFixed(3)}">${formatSeconds(processedSplice)}</button></td>
        <td>${(decision.confidence * 100).toFixed(0)}%</td>
        <td>${escapeHtml(decision.action)}</td>
        <td>${escapeHtml(decision.advertiser ?? "unknown")}</td>
        <td>${escapeHtml(decision.reason)}</td>
      </tr>`;
    })
    .join("");
  return `<section class="audit-table">
    <h3>Decisions</h3>
    <table>
      <thead><tr><th>Model Start</th><th>Model End</th><th>Model Duration</th><th>Rendered Cut</th><th>Processed Splice</th><th>Confidence</th><th>Action</th><th>Advertiser</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderChapterTable(episode: UiEpisode): string {
  if (episode.chapters.length === 0) return "";
  const processedDuration = episode.ui.processedDurationSeconds ?? episode.processedDurationSeconds;
  const chapters = [...episode.chapters].sort((a, b) => a.startTime - b.startTime).slice(0, 10);
  const rows = chapters
    .map((chapter, index) => {
      const nextStart = chapters[index + 1]?.startTime ?? processedDuration;
      const end = nextStart != null && nextStart > chapter.startTime ? nextStart : undefined;
      return `<tr>
        <td><button data-jump-processed="${chapter.startTime.toFixed(3)}">${formatSeconds(chapter.startTime)}</button></td>
        <td>${formatSeconds(end)}</td>
        <td>${formatSeconds(end == null ? undefined : end - chapter.startTime)}</td>
        <td>${escapeHtml(chapter.title)}</td>
      </tr>`;
    })
    .join("");
  return `<section class="audit-table">
    <h3>Chapters</h3>
    <table>
      <thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Topic</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderTranscript(
  episode: UiEpisode,
  config: DeepDiveConfig
): string {
  const segments = episode.ui.transcriptSegments ?? [];
  if (segments.length === 0) return "";
  const sourceDuration = episode.ui.sourceDurationSeconds ?? episode.originalDurationSeconds;
  const jingleDuration = config.audio.jingle.enabled ? config.audio.jingle.durationSeconds : 0;
  const removals = actualRemovalWindows(episode, sourceDuration, config);
  const sourceRows = segments
    .map((segment, index) => {
      const status = segmentRemovalStatus(segment, removals);
      const className = status.kind === "removed" ? "removed-row" : status.kind === "partial" ? "partial-row" : "";
      return `<tr class="${className}" id="source-segment-${index}">
        <td><button data-jump-source="${segment.start.toFixed(3)}">${formatSeconds(segment.start)}</button></td>
        <td>${formatSeconds(segment.end)}</td>
        <td>${renderSegmentStatus(status)}</td>
        <td>${escapeHtml(segment.text)}</td>
      </tr>`;
    })
    .join("");
  const processedRows = segments
    .filter((segment) => segmentRemovalStatus(segment, removals).kind !== "removed")
    .map((segment, index) => {
      const visible = visibleSegmentWindow(segment, removals);
      const start = mapOriginalToProcessed(visible.start, removals, jingleDuration);
      const end = mapOriginalToProcessed(visible.end, removals, jingleDuration);
      const status = segmentRemovalStatus(segment, removals);
      return `<tr id="processed-segment-${index}">
        <td><button data-jump-processed="${start.toFixed(3)}">${formatSeconds(start)}</button></td>
        <td>${formatSeconds(end)}</td>
        <td>${formatSeconds(segment.start)}</td>
        <td>${status.kind === "partial" ? '<span class="pill warn">partial cut</span> ' : ""}${escapeHtml(segment.text)}</td>
      </tr>`;
    })
    .join("");
  const statuses = segments.map((segment) => segmentRemovalStatus(segment, removals));
  const removedCount = statuses.filter((status) => status.kind === "removed").length;
  const partialCount = statuses.filter((status) => status.kind === "partial").length;
  return `<section class="transcript-wrap">
    <details class="transcript">
      <summary>Source transcript (${segments.length} segments, ${removedCount} removed, ${partialCount} partial)</summary>
      <table>
        <thead><tr><th>Start</th><th>End</th><th>Status</th><th>Text</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>
    </details>
    <details class="transcript">
      <summary>Processed transcript (${segments.length - removedCount} remaining, ${partialCount} partial, remapped)</summary>
    <table>
        <thead><tr><th>Processed</th><th>End</th><th>Source</th><th>Text</th></tr></thead>
        <tbody>${processedRows}</tbody>
    </table>
    </details>
  </section>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --ink:#1f2933; --muted:#607080; --line:#d8dee6; --bg:#f6f8fa; --panel:#fff; --accent:#0f766e; }
    body { margin:0; font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
    header, main, section { max-width:1120px; margin:0 auto; padding:24px; }
    h1 { margin:0 0 6px; font-size:28px; font-weight:700; }
    h2 { margin:0; font-size:17px; }
    h3 { margin:16px 0 6px; font-size:13px; text-transform:uppercase; color:var(--muted); }
    a { color:var(--accent); text-decoration:none; }
    .panel, .episode { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .section-head h2 { font-size:16px; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:11px 10px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; }
    .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }
    .meta div { display:flex; flex-direction:column; gap:4px; min-width:0; }
    .meta span, dt { color:var(--muted); font-size:12px; text-transform:uppercase; }
    code { white-space:normal; overflow-wrap:anywhere; }
    .episodes { display:grid; gap:14px; }
    .episode { padding:18px; }
    .episode-head { display:flex; justify-content:space-between; gap:12px; align-items:start; }
    .episode-head span { border:1px solid var(--line); border-radius:999px; padding:3px 9px; color:var(--muted); }
    dl { display:grid; grid-template-columns:130px 1fr; gap:6px 12px; margin:14px 0 0; }
    dd { margin:0; min-width:0; overflow-wrap:anywhere; }
    ul, ol { margin:0; padding-left:20px; }
    .activity { margin:0 auto 14px; }
    .activity ol { display:grid; gap:8px; padding-left:0; list-style:none; margin-top:12px; }
    .activity li { display:grid; grid-template-columns:88px minmax(130px,1fr) minmax(80px,120px) minmax(120px,1.4fr); gap:8px; align-items:start; border-top:1px solid var(--line); padding-top:8px; }
    .activity li:first-child { border-top:0; padding-top:0; }
    .activity li.warn strong { color:#9a3412; }
    .activity li.error strong { color:#991b1b; }
    .activity time, .activity span, .activity em { color:var(--muted); font-style:normal; }
    .activity code { grid-column:1 / -1; color:var(--muted); font-size:12px; }
    audio { width:100%; height:34px; }
    .compare { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:14px; }
    .timeline-block { margin-top:14px; padding:0; }
    .timeline-head { display:flex; justify-content:space-between; gap:12px; align-items:end; }
    .timeline-head span { color:var(--muted); font-size:12px; }
    .timeline-label { display:flex; justify-content:space-between; margin-top:10px; color:var(--muted); font-size:12px; }
    .timeline { position:relative; height:30px; border:1px solid var(--line); border-radius:6px; background:linear-gradient(90deg,#f8fafc,#eef2f7); overflow:hidden; cursor:pointer; }
    .timeline:focus-visible { outline:2px solid rgba(15,118,110,.35); outline-offset:2px; }
    .timeline.processed { background:linear-gradient(90deg,#f9fafb,#f1f5f9); }
    button { font:inherit; color:inherit; }
    .cut { position:absolute; top:0; bottom:0; padding:0; background:rgba(220,38,38,.65); border-left:1px solid rgba(127,29,29,.8); border-right:1px solid rgba(127,29,29,.8); pointer-events:none; }
    .tick { position:absolute; top:0; bottom:0; width:4px; padding:0; background:rgba(15,118,110,.85); transform:translateX(-1px); pointer-events:none; }
    .splice { position:absolute; top:0; bottom:0; width:2px; background:rgba(37,99,235,.85); pointer-events:none; }
    .legend { display:flex; gap:16px; align-items:center; margin-top:6px; color:var(--muted); font-size:12px; }
    .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
    .legend .red { background:rgba(220,38,38,.65); }
    .legend .green { background:rgba(15,118,110,.85); }
    .legend .blue { background:rgba(37,99,235,.85); }
    .cut-list { display:grid; gap:8px; margin:10px 0 0; padding-left:0; list-style:none; }
    .cut-list li { display:grid; grid-template-columns:auto auto 1fr auto; gap:8px; align-items:center; padding:8px; border:1px solid var(--line); border-radius:6px; background:#fafafa; }
    .cut-list button, .transcript button, .audit-table button { border:1px solid var(--line); border-radius:5px; background:#fff; color:var(--accent); padding:3px 7px; cursor:pointer; }
    .cut-list small { color:var(--muted); white-space:nowrap; }
    .audit-table { padding:0; margin-top:14px; }
    .audit-table table { font-size:12px; }
    .audit-table th, .audit-table td { padding:8px 10px; }
    .audit-table td:first-child, .audit-table td:nth-child(2), .audit-table td:nth-child(3), .audit-table td:nth-child(4), .audit-table td:nth-child(5), .audit-table td:nth-child(6) { white-space:nowrap; }
    .transcript-wrap { padding:0; margin-top:16px; }
    details.transcript { margin-top:10px; border-top:1px solid var(--line); padding-top:12px; }
    summary { cursor:pointer; color:var(--accent); font-weight:600; }
    .transcript table { margin-top:10px; font-size:12px; }
    .transcript td:first-child, .transcript td:nth-child(2), .transcript td:nth-child(3) { white-space:nowrap; color:var(--muted); width:74px; }
    .removed-row td { background:rgba(220,38,38,.08); }
    .removed-row td:last-child { text-decoration:line-through; color:#7f1d1d; }
    .partial-row td { background:rgba(245,158,11,.10); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 7px; color:var(--muted); font-size:11px; }
    .pill.danger { border-color:rgba(220,38,38,.35); color:#991b1b; background:rgba(220,38,38,.08); }
    .pill.warn { border-color:rgba(217,119,6,.35); color:#92400e; background:rgba(245,158,11,.10); }
    @media (max-width: 760px) {
      .activity li { grid-template-columns:1fr; }
      .cut-list li { grid-template-columns:1fr 1fr; }
      .cut-list span, .cut-list small { grid-column:1 / -1; }
    }
  </style>
  <script>
    function jumpAudio(episode, target, seconds) {
      const audio = episode.querySelector(target === "source" ? "audio[data-role='source-audio']" : "audio[data-role='processed-audio']");
      if (!audio || !Number.isFinite(seconds)) return;
      episode.querySelectorAll("audio").forEach((candidate) => {
        if (candidate !== audio) candidate.pause();
      });
      const targetSeconds = Math.max(0, seconds);
      const seek = () => {
        try {
          audio.currentTime = targetSeconds;
        } catch {
          return;
        }
        audio.play().catch(() => {});
      };
      if (audio.readyState < 1) {
        audio.addEventListener("loadedmetadata", seek, { once: true });
        audio.load();
        return;
      }
      seek();
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-jump-source],button[data-jump-processed]");
      if (button) {
        const episode = button.closest(".episode");
        if (!episode) return;
        const sourceTarget = button.getAttribute("data-jump-source");
        const processedTarget = button.getAttribute("data-jump-processed");
        jumpAudio(episode, sourceTarget != null ? "source" : "processed", Number(sourceTarget ?? processedTarget));
        return;
      }

      const timeline = event.target.closest(".timeline[data-timeline-target]");
      if (!timeline) return;
      const episode = timeline.closest(".episode");
      const duration = Number(timeline.getAttribute("data-duration"));
      const rect = timeline.getBoundingClientRect();
      if (!episode || !Number.isFinite(duration) || rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      jumpAudio(episode, timeline.getAttribute("data-timeline-target"), ratio * duration);
    });

    document.addEventListener("keydown", (event) => {
      const timeline = event.target.closest?.(".timeline[data-timeline-target]");
      if (!timeline || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const episode = timeline.closest(".episode");
      const duration = Number(timeline.getAttribute("data-duration"));
      if (!episode || !Number.isFinite(duration)) return;
      jumpAudio(episode, timeline.getAttribute("data-timeline-target"), duration / 2);
    });
  </script>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}

function formatSeconds(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function timeSaved(sourceDuration: number | undefined, processedDuration: number | undefined): number | undefined {
  if (sourceDuration == null || processedDuration == null) return undefined;
  return Math.max(0, sourceDuration - processedDuration);
}

function transcriptionLabel(config: NonNullable<Awaited<ReturnType<typeof getPodcastDeepDive>>>["config"]["transcripts"]): string {
  if (config.providers.openRouter.enabled) return `OpenRouter ${config.providers.openRouter.model}`;
  if (config.providers.openai.enabled) return `OpenAI ${config.providers.openai.model}`;
  if (config.providers.pocketCasts.enabled) return "Pocket Casts experimental";
  if (config.providers.feed.enabled) return "feed transcripts";
  return "disabled";
}

function actualRemovalWindows(
  episode: NonNullable<Awaited<ReturnType<typeof getPodcastDeepDive>>>["episodes"][number],
  duration: number | undefined,
  config: NonNullable<Awaited<ReturnType<typeof getPodcastDeepDive>>>["config"]
): Segment[] {
  return normalizeSegments(removalSegments(episode.decisions, config.processing.confidenceThreshold), {
    durationSeconds: duration,
    paddingSeconds: config.detection.paddingSeconds,
    minSegmentSeconds: config.detection.minSegmentSeconds,
    maxSegmentSeconds: config.detection.maxSegmentSeconds
  });
}

function labelsForWindow(
  episode: NonNullable<Awaited<ReturnType<typeof getPodcastDeepDive>>>["episodes"][number],
  window: Segment
): string[] {
  const reasons = episode.decisions
    .filter((decision) => decision.action === "remove" && decision.end > window.start && decision.start < window.end)
    .map((decision) => [decision.advertiser, decision.reason].filter(Boolean).join(": "));
  return Array.from(new Set(reasons)).slice(0, 3);
}

function segmentRemovalStatus(segment: { start: number; end: number }, removals: Segment[]): { kind: "kept" | "partial" | "removed"; overlapSeconds: number; ranges: Segment[] } {
  const ranges = removals
    .map((removal) => ({ start: Math.max(segment.start, removal.start), end: Math.min(segment.end, removal.end) }))
    .filter((range) => range.end > range.start);
  const overlapSeconds = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  const duration = Math.max(0, segment.end - segment.start);
  if (overlapSeconds <= 0.01) return { kind: "kept", overlapSeconds: 0, ranges: [] };
  if (overlapSeconds >= Math.max(0, duration - 0.05)) return { kind: "removed", overlapSeconds, ranges };
  return { kind: "partial", overlapSeconds, ranges };
}

function renderSegmentStatus(status: ReturnType<typeof segmentRemovalStatus>): string {
  if (status.kind === "removed") return `<span class="pill danger">removed</span>`;
  if (status.kind === "partial") {
    const ranges = status.ranges.map((range) => `${formatSeconds(range.start)}-${formatSeconds(range.end)}`).join(", ");
    return `<span class="pill warn">partial ${formatSeconds(status.overlapSeconds)}</span>${ranges ? ` <small>${escapeHtml(ranges)}</small>` : ""}`;
  }
  return `<span class="pill">kept</span>`;
}

function visibleSegmentWindow(segment: { start: number; end: number }, removals: Segment[]): Segment {
  let start = segment.start;
  let end = segment.end;
  for (const removal of removals) {
    if (removal.end <= start || removal.start >= end) continue;
    if (removal.start <= start && removal.end < end) {
      start = removal.end;
      continue;
    }
    if (removal.start > start && removal.end >= end) {
      end = removal.start;
      continue;
    }
  }
  return end > start ? { start, end } : segment;
}

function renderWindowForDecision(decision: { start: number; end: number }, removals: Segment[]): Segment | undefined {
  return removals.find((removal) => removal.end >= decision.start && removal.start <= decision.end);
}

function compactReason(reason: string): string {
  return reason
    .replace(/^sponsor read\s*(for)?\s*/i, "")
    .replace(/^ad\s*[:\-]\s*/i, "")
    .trim()
    .slice(0, 90);
}

function renderQualityLabel(audio: EpisodeManifest["audio"]): string {
  if (audio.renderMode === "source-copy") return `source-copy${audio.bitrateKbps ? ` · ${audio.bitrateKbps} kbps` : ""}`;
  if (audio.renderMode === "encode") return `encoded${audio.bitrateKbps ? ` · ${audio.bitrateKbps} kbps` : ""}`;
  return audio.renderMode ?? "unknown";
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatActivityDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}
