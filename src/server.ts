import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig, EpisodeManifest, LlmUsage } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed, rewriteFeed } from "./feed.js";
import { episodePaths, podcastAssetPaths, readManifest } from "./storage.js";
import { absoluteUrl, pathExists, readJson } from "./utils.js";
import { ensureCompatiblePodcastArtwork } from "./artwork.js";
import { getAutomationState, startAutomation } from "./automation.js";
import { getPodcastDeepDive, listPodcastSummaries } from "./library.js";
import { mapOriginalToProcessed, normalizeSegments, removalSegments, type Segment } from "./timeline.js";
import { readRecentActivity, type ActivityEvent } from "./activity.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { enqueueManualReprocess, listQueueEpisodes, resetQueueAttempts, type ManualReprocessScope, type QueueEpisode } from "./queue.js";
import { applyRuntimeOverridesObject, loadRuntimeOverrides, updateRuntimeTuning, type RuntimeTuning } from "./runtime-overrides.js";
import { summarizeCosts, type CostSummary } from "./costs.js";

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
    const [podcasts, activity, queue] = await Promise.all([listPodcastSummaries(config), readRecentActivity(config, 25), listQueueEpisodes(config)]);
    return renderPodcastList(podcasts, getAutomationState(), activity, queue);
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

  app.get("/costs", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderCostDashboard(await summarizeCosts(config));
  });

  app.get("/api/costs", async () => ({
    costs: await summarizeCosts(config)
  }));

  app.get("/api/queue", async () => ({
    queue: await listQueueEpisodes(config),
    automation: getAutomationState()
  }));

  app.get("/api/runtime-overrides", async () => ({
    overrides: await loadRuntimeOverrides(config)
  }));

  app.post("/api/actions/reprocess", async (request, reply) => {
    if (!authorizeAdmin(config, request, reply)) return reply;
    const body = actionBody(request.body);
    const scope = parseScope(body.scope);
    if (!scope) {
      reply.code(400);
      return { error: "scope must be episode, podcast, global, or failed" };
    }
    if ((scope === "episode" || scope === "podcast") && !body.podcastSlug) {
      reply.code(400);
      return { error: "podcastSlug is required for this scope" };
    }
    if (scope === "episode" && !body.episodeKey) {
      reply.code(400);
      return { error: "episodeKey is required for episode scope" };
    }
    const requestEntry = await enqueueManualReprocess(config, {
      scope,
      podcastSlug: stringValue(body.podcastSlug),
      episodeKey: stringValue(body.episodeKey),
      options: {
        force: boolValue(body.force),
        dryRun: boolValue(body.dryRun),
        downloadAudio: boolValue(body.downloadAudio),
        skipArtwork: boolValue(body.skipArtwork),
        reuseTranscript: boolValue(body.reuseTranscript),
        fullReprocess: boolValue(body.fullReprocess),
        lookbackDays: numberValue(body.lookbackDays),
        maxEpisodes: numberValue(body.maxEpisodes)
      }
    });
    return { ok: true, request: requestEntry };
  });

  app.post("/api/actions/reset-attempts", async (request, reply) => {
    if (!authorizeAdmin(config, request, reply)) return reply;
    const body = actionBody(request.body);
    const reset = await resetQueueAttempts(config, {
      podcastSlug: stringValue(body.podcastSlug),
      episodeKey: stringValue(body.episodeKey),
      allQuarantined: body.allQuarantined == null ? true : boolValue(body.allQuarantined)
    });
    return { ok: true, reset };
  });

  app.post("/api/runtime-overrides/tuning", async (request, reply) => {
    if (!authorizeAdmin(config, request, reply)) return reply;
    const body = actionBody(request.body);
    const scope = body.scope === "podcast" ? { type: "podcast" as const, podcastSlug: stringValue(body.podcastSlug) ?? "" } : { type: "global" as const };
    if (scope.type === "podcast" && !scope.podcastSlug) {
      reply.code(400);
      return { error: "podcastSlug is required for podcast tuning" };
    }
    const tuning = parseTuning(body);
    const overrides = await updateRuntimeTuning(config, scope, tuning);
    Object.assign(config, applyRuntimeOverridesObject(config, overrides));
    return { ok: true, overrides };
  });

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
    const { podcastSlug: rawPodcastSlug } = request.params as { podcastSlug: string };
    const feedRequest = resolveFeedRequest(config, rawPodcastSlug);
    if (!feedRequest) {
      reply.code(404);
      return { error: "podcast not found" };
    }
    reply.type("application/rss+xml; charset=utf-8");
    return getRewrittenFeed(config, feedRequest.podcastSlug, feedRequest);
  });

  app.get("/feeds/:podcastSlug/:variant.xml", async (request, reply) => {
    const { podcastSlug, variant } = request.params as { podcastSlug: string; variant: string };
    const feedRequest = resolveFeedRequest(config, podcastSlug, variant);
    if (!feedRequest) {
      reply.code(404);
      return { error: "podcast not found" };
    }
    reply.type("application/rss+xml; charset=utf-8");
    return getRewrittenFeed(config, feedRequest.podcastSlug, feedRequest);
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

  app.get("/assets/:podcastSlug/:episodeKey/transcript.json", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.transcriptJson))) {
      reply.code(404);
      return { error: "transcript not found" };
    }
    reply.type("application/json");
    return reply.send(createReadStream(paths.transcriptJson));
  });

  app.get("/assets/:podcastSlug/:episodeKey/manifest.json", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const paths = episodePaths(config, podcastSlug, episodeKey);
    if (!(await pathExists(paths.manifest))) {
      reply.code(404);
      return { error: "manifest not found" };
    }
    reply.type("application/json");
    return reply.send(createReadStream(paths.manifest));
  });

  app.get("/assets/:podcastSlug/artwork.png", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    const paths = podcastAssetPaths(config, podcastSlug);
    if (!(await pathExists(paths.artwork))) {
      reply.code(404);
      return { error: "artwork not found" };
    }
    const meta = await readJson<{ outputMimeType?: string }>(paths.artworkMeta);
    return sendStaticAsset(reply, paths.artwork, meta?.outputMimeType || "image/png", "public, max-age=86400");
  });

  app.get("/assets/:podcastSlug/artwork.jpg", async (request, reply) => {
    const { podcastSlug } = request.params as { podcastSlug: string };
    const artwork = await ensureCompatiblePodcastArtwork(config, podcastSlug);
    if (!artwork) {
      reply.code(404);
      return { error: "artwork not found" };
    }
    return sendStaticAsset(reply, artwork.path, artwork.mimeType, "public, max-age=31536000, immutable");
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

async function sendStaticAsset(reply: FastifyReply, filePath: string, contentType: string, cacheControl: string) {
  const info = await stat(filePath);
  reply.type(contentType);
  reply.header("Content-Length", String(info.size));
  reply.header("Last-Modified", info.mtime.toUTCString());
  reply.header("Cache-Control", cacheControl);
  return reply.send(createReadStream(filePath));
}

interface FeedRequest {
  podcastSlug: string;
  feedPath: string;
  identityKey: string;
}

function resolveFeedRequest(config: AppConfig, rawPodcastSlug: string, rawVariant?: string): FeedRequest | undefined {
  if (rawVariant != null) {
    if (!config.podcasts[rawPodcastSlug]) return undefined;
    const variant = sanitizeFeedVariant(rawVariant);
    if (!variant) return undefined;
    return {
      podcastSlug: rawPodcastSlug,
      feedPath: `/feeds/${rawPodcastSlug}/${variant}.xml`,
      identityKey: `${rawPodcastSlug}:${variant}`
    };
  }

  if (config.podcasts[rawPodcastSlug]) {
    return {
      podcastSlug: rawPodcastSlug,
      feedPath: `/feeds/${rawPodcastSlug}.xml`,
      identityKey: rawPodcastSlug
    };
  }

  const suffix = "-ad-free";
  if (rawPodcastSlug.endsWith(suffix)) {
    const podcastSlug = rawPodcastSlug.slice(0, -suffix.length);
    if (config.podcasts[podcastSlug]) {
      return {
        podcastSlug,
        feedPath: `/feeds/${rawPodcastSlug}.xml`,
        identityKey: rawPodcastSlug
      };
    }
  }

  return undefined;
}

function sanitizeFeedVariant(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

async function getRewrittenFeed(config: AppConfig, podcastSlug: string, feedRequest: FeedRequest): Promise<string> {
  const now = Date.now();
  const cacheKey = feedRequest.identityKey;
  const cached = feedCache.get(cacheKey);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.pending) return cached.pending;

  const pending = buildRewrittenFeed(config, podcastSlug, feedRequest).then(
    (value) => {
      feedCache.set(cacheKey, { value, expiresAt: Date.now() + FEED_CACHE_MS });
      return value;
    },
    (error) => {
      feedCache.delete(cacheKey);
      throw error;
    }
  );
  feedCache.set(cacheKey, { pending, expiresAt: now + FEED_CACHE_MS });
  return pending;
}

async function buildRewrittenFeed(config: AppConfig, podcastSlug: string, feedRequest: FeedRequest): Promise<string> {
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
    artworkUrl,
    feedPath: feedRequest.feedPath,
    identityKey: feedRequest.identityKey
  });
}

async function localArtworkUrl(config: AppConfig, podcastSlug: string): Promise<string | undefined> {
  const paths = podcastAssetPaths(config, podcastSlug);
  if (!(await pathExists(paths.artwork))) return undefined;
  return absoluteUrl(config.server.publicBaseUrl, `/assets/${podcastSlug}/artwork.jpg`);
}

function renderPodcastList(
  podcasts: Awaited<ReturnType<typeof listPodcastSummaries>>,
  automation: ReturnType<typeof getAutomationState>,
  activity: ActivityEvent[],
  queue: QueueEpisode[]
): string {
  return page(
    "Podcast Proxy",
    `<header class="app-header">
      <div>
        <p class="eyebrow">Podcastoor</p>
        <h1>Podcast Proxy</h1>
        <p><span class="status-dot ${automation.running ? "running" : ""}"></span>${automation.running ? "Processing is running" : "Processing is idle"}${
          automation.lastFinishedAt ? ` · last finished ${renderLocalTime(automation.lastFinishedAt)}` : ""
        }</p>
      </div>
      <nav class="header-actions"><a href="/costs">Cost dashboard</a><a href="/api/queue">Queue JSON</a></nav>
    </header>
    <main class="home-stack">
      <section class="panel podcasts-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Feeds</p>
            <h2>Podcasts</h2>
          </div>
          <span>${podcasts.length} configured</span>
        </div>
        <div class="podcast-grid">
          ${podcasts.map(renderPodcastSummaryCard).join("") || `<p class="empty">No podcasts configured.</p>`}
        </div>
      </section>
    </main>
    ${renderControlPanel(podcasts)}
    ${renderQueue(queue)}
    ${renderActivityLog(activity)}`
  );
}

function renderPodcastSummaryCard(podcast: Awaited<ReturnType<typeof listPodcastSummaries>>[number]): string {
  const latest = podcast.latestEpisode;
  return `<article class="podcast-card">
    <div class="podcast-card-top">
      <div>
        <h3><a href="/podcasts/${podcast.slug}">${escapeHtml(podcast.name)}</a></h3>
        <p>${latest ? escapeHtml(latest.title) : "No processed episodes yet"}</p>
      </div>
      <span class="state ${escapeHtml(latest?.status ?? "skipped")}">${escapeHtml(latest?.status ?? "empty")}</span>
    </div>
    <dl class="metric-grid compact">
      <div><dt>Manifests</dt><dd>${podcast.manifestCount}</dd></div>
      <div><dt>Rendered</dt><dd>${podcast.processedCount}</dd></div>
      <div><dt>Latest</dt><dd>${renderLocalTime(latest?.pubDate)}</dd></div>
      <div><dt>Transcription</dt><dd>${escapeHtml(podcast.transcriptionModel)}</dd></div>
      <div><dt>Classifier</dt><dd>${escapeHtml(podcast.classifierModel)}</dd></div>
    </dl>
    <div class="link-row">
      <a href="/podcasts/${podcast.slug}">Open</a>
      <a href="/feeds/${podcast.slug}.xml">RSS</a>
      <a href="/feeds/${podcast.slug}/ad-free.xml">Alt RSS</a>
    </div>
  </article>`;
}

function renderControlPanel(podcasts: Awaited<ReturnType<typeof listPodcastSummaries>>): string {
  const podcastOptions = podcasts.map((podcast) => `<option value="${escapeHtml(podcast.slug)}">${escapeHtml(podcast.name)}</option>`).join("");
  return `<section class="panel controls">
    <div class="section-head"><h2>Controls</h2><span>Admin token required</span></div>
    <form data-admin-action="reprocess">
      <label>Scope
        <select name="scope">
          <option value="failed">Failed/quarantined</option>
          <option value="global">Last N days</option>
          <option value="podcast">Podcast</option>
        </select>
      </label>
      <label>Podcast
        <select name="podcastSlug"><option value="">All podcasts</option>${podcastOptions}</select>
      </label>
      <label>Lookback days <input name="lookbackDays" type="number" min="1" max="60" value="7"></label>
      <label>Max episodes <input name="maxEpisodes" type="number" min="1" max="100" value="20"></label>
      <label><input name="force" type="checkbox" checked> Force</label>
      <label><input name="reuseTranscript" type="checkbox" checked> Reuse transcript</label>
      <label><input name="skipArtwork" type="checkbox" checked> Skip artwork</label>
      <button type="submit">Enqueue</button>
    </form>
    <form data-admin-action="reset-attempts">
      <input type="hidden" name="allQuarantined" value="true">
      <button type="submit">Reset failed/quarantined attempts</button>
    </form>
    <form data-admin-action="tuning">
      <input type="hidden" name="scope" value="global">
      <label>Confidence <input name="confidenceThreshold" type="number" min="0" max="1" step="0.01"></label>
      <label>Fallback padding <input name="paddingSeconds" type="number" min="0" max="10" step="0.1"></label>
      <label>Before cut <input name="prePaddingSeconds" type="number" min="0" max="10" step="0.1"></label>
      <label>After cut <input name="postPaddingSeconds" type="number" min="0" max="10" step="0.1"></label>
      <label>Min cut <input name="minSegmentSeconds" type="number" min="0" max="120" step="0.5"></label>
      <label>Max cut <input name="maxSegmentSeconds" type="number" min="1" max="1200" step="1"></label>
      <label><input name="markerToneEnabled" type="checkbox"> Marker tone</label>
      <button type="submit">Save global tuning</button>
    </form>
  </section>`;
}

function renderQueue(queue: QueueEpisode[]): string {
  const rows = queue.slice(0, 30).map((entry) => {
    const lastError = entry.lastError ? `<code>${escapeHtml(entry.lastError.slice(0, 220))}</code>` : "";
    return `<tr>
      <td><span class="state ${escapeHtml(entry.state)}">${escapeHtml(entry.state)}</span></td>
      <td>${escapeHtml(entry.podcastSlug)}</td>
      <td><a href="/podcasts/${entry.podcastSlug}">${escapeHtml(entry.episodeTitle)}</a></td>
      <td>${renderLocalTime(entry.pubDate)}</td>
      <td>${entry.attempts}/${entry.maxAttempts}</td>
      <td>${renderLocalTime(entry.lastAttemptAt)}</td>
      <td>${renderLocalTime(entry.nextRetryAt)}</td>
      <td>${escapeHtml(entry.currentStage)}</td>
      <td>${lastError}</td>
    </tr>`;
  });
  const cards = queue.slice(0, 30).map((entry) => {
    const lastError = entry.lastError ? `<code>${escapeHtml(entry.lastError.slice(0, 220))}</code>` : "";
    return `<article class="queue-card">
      <div class="queue-card-head">
        <span class="state ${escapeHtml(entry.state)}">${escapeHtml(entry.state)}</span>
        <strong>${entry.attempts}/${entry.maxAttempts}</strong>
      </div>
      <h3><a href="/podcasts/${entry.podcastSlug}">${escapeHtml(entry.episodeTitle)}</a></h3>
      <dl class="metric-grid compact">
        <div><dt>Podcast</dt><dd>${escapeHtml(entry.podcastSlug)}</dd></div>
        <div><dt>Published</dt><dd>${renderLocalTime(entry.pubDate)}</dd></div>
        <div><dt>Last Attempt</dt><dd>${renderLocalTime(entry.lastAttemptAt)}</dd></div>
        <div><dt>Next Retry</dt><dd>${renderLocalTime(entry.nextRetryAt)}</dd></div>
        <div><dt>Stage</dt><dd>${escapeHtml(entry.currentStage)}</dd></div>
      </dl>
      ${lastError ? `<div class="queue-error">${lastError}</div>` : ""}
    </article>`;
  });
  return `<section class="panel queue">
    <div class="section-head"><h2>Processing Queue</h2><a href="/api/queue">JSON</a></div>
    <div class="queue-cards">${cards.length ? cards.join("") : `<p class="empty">No queue state yet.</p>`}</div>
    <table class="queue-table">
      <thead><tr><th>State</th><th>Podcast</th><th>Episode</th><th>Published</th><th>Attempts</th><th>Last Attempt</th><th>Next Retry</th><th>Stage</th><th>Last Error</th></tr></thead>
      <tbody>${rows.length ? rows.join("") : `<tr><td colspan="9">No queue state yet.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function renderActivityLog(activity: ActivityEvent[]): string {
  const rows = activity.length
    ? activity
        .map(
          (event) => `<li class="${escapeHtml(event.level)}">
            ${renderLocalTime(event.at, "activity")}
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
    `<header class="app-header">
      <div>
        <a class="back-link" href="/">Back</a>
        <p class="eyebrow">Podcast</p>
        <h1>${escapeHtml(deepDive.name)}</h1>
        <p class="feed-url" title="${escapeHtml(deepDive.feedUrl)}">${escapeHtml(deepDive.feedUrl)}</p>
      </div>
      <nav class="header-actions"><a href="${escapeHtml(deepDive.subscriptionUrl)}">RSS</a><a href="${escapeHtml(deepDive.alternateSubscriptionUrl)}">Alt RSS</a></nav>
    </header>
    ${renderPodcastOverview(deepDive)}
    <section class="panel meta">
      <div><span>Subscription URL</span><code>${escapeHtml(deepDive.subscriptionUrl)}</code></div>
      <div><span>Alternate URL</span><code>${escapeHtml(deepDive.alternateSubscriptionUrl)}</code></div>
      <div><span>Lookback</span><strong>${deepDive.lookbackDays} days</strong></div>
      <div><span>Automation</span><strong>${automation.running ? "running" : "idle"} · every ${deepDive.config.automation.intervalMinutes} min</strong></div>
      <div><span>Confidence</span><strong>${deepDive.config.effectiveProcessing.confidenceThreshold}</strong></div>
      <div><span>Cut Padding</span><strong>${deepDive.config.detection.prePaddingSeconds}s before · ${deepDive.config.detection.postPaddingSeconds}s after</strong></div>
      <div><span>Cut Limits</span><strong>${deepDive.config.detection.minSegmentSeconds}s-${deepDive.config.detection.maxSegmentSeconds}s</strong></div>
      <div><span>Marker Tone</span><strong>${deepDive.config.audio.jingle.enabled ? "enabled" : "disabled"}</strong></div>
      <div><span>Model</span><strong>${escapeHtml(deepDive.config.llm.enabled ? deepDive.config.llm.model : "disabled")}</strong></div>
      <div><span>Transcription</span><strong>${escapeHtml(transcriptionLabel(deepDive.config.transcripts))}</strong></div>
    </section>
    ${renderPodcastControls(deepDive)}
    <main class="episodes">
      ${deepDive.episodes
        .map((episode) => {
          const sourceDuration = episode.ui.sourceDurationSeconds;
          const processedDuration = episode.ui.processedDurationSeconds;
          const transcriptCost = episode.transcript?.costUsd ?? 0;
          const textLlmCost = (episode.llm ?? []).reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
          const transcriptSegments = episode.transcript?.segmentCount ?? episode.ui.transcriptSegments.length;
          return `<article class="episode" id="${escapeHtml(episode.episodeKey)}">
            <div class="episode-head">
              <div>
                <p class="eyebrow">${renderLocalTime(episode.pubDate)}</p>
                <h2>${escapeHtml(episode.title)}</h2>
              </div>
              <span class="state ${escapeHtml(episode.audio.status)}">${escapeHtml(episode.audio.status)}</span>
            </div>
            <dl class="metric-grid episode-metrics">
              <div><dt>RSS Duration</dt><dd>${formatSeconds(episode.originalDurationSeconds)}</dd></div>
              <div><dt>Source Audio</dt><dd>${formatSeconds(sourceDuration)}</dd></div>
              <div><dt>Processed Audio</dt><dd>${formatSeconds(processedDuration)}</dd></div>
              <div><dt>Time Saved</dt><dd>${formatSeconds(timeSaved(sourceDuration, processedDuration))}${episode.audio.jingleInsertedCount ? ` · ${episode.audio.jingleInsertedCount} markers` : ""}</dd></div>
              <div><dt>Render</dt><dd>${escapeHtml(renderQualityLabel(episode.audio))}</dd></div>
              <div><dt>Decisions</dt><dd>${episode.decisions.length}</dd></div>
              <div><dt>Chapters</dt><dd>${episode.chapters.length}</dd></div>
              <div><dt>Total Cost</dt><dd>$${episode.costs.actualUsd.toFixed(6)}</dd></div>
              <div><dt>Transcript</dt><dd>${escapeHtml(episode.transcript?.model ?? episode.transcript?.source ?? "unknown")}</dd></div>
              <div><dt>Transcript Cost</dt><dd>$${transcriptCost.toFixed(6)}${transcriptSegments ? ` · ${transcriptSegments} segments` : ""}</dd></div>
              <div><dt>Ad Model</dt><dd>${escapeHtml(llmModelLabel(episode, "ad-detection"))}</dd></div>
              <div><dt>Boundary Model</dt><dd>${escapeHtml(llmModelLabel(episode, "boundary-review"))}</dd></div>
              <div><dt>Chapter Model</dt><dd>${escapeHtml(llmModelLabel(episode, "chapter-generation"))}</dd></div>
              <div><dt>Text LLM</dt><dd>$${textLlmCost.toFixed(6)} · ${(episode.llm ?? []).length} calls</dd></div>
              <div><dt>Alignment</dt><dd>${renderAlignmentSummary(episode)}</dd></div>
            </dl>
            ${renderArtifactLinks(episode)}
            ${renderAudioCompare(episode)}
            ${renderEpisodeControls(deepDive.slug, episode)}
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

function renderPodcastOverview(deepDive: DeepDive): string {
  const metadata = deepDive.metadata;
  const artworkUrl = metadata.localArtworkUrl ?? metadata.sourceImageUrl;
  const title = metadata.feedTitle || deepDive.name;
  const description = metadata.description || (metadata.feedError ? `Source metadata unavailable: ${metadata.feedError}` : "No source description found in the RSS feed.");
  return `<section class="panel podcast-overview">
    ${
      artworkUrl
        ? `<img class="podcast-art" src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)} artwork">`
        : `<div class="podcast-art placeholder-art">Ad Free</div>`
    }
    <div class="podcast-overview-body">
      <div class="section-head">
        <h2>${escapeHtml(title)}</h2>
        <span><a href="/feeds/${deepDive.slug}.xml">RSS</a> · <a href="/feeds/${deepDive.slug}/ad-free.xml">Alt RSS</a></span>
      </div>
      <p>${escapeHtml(description)}</p>
      <div class="overview-stats">
        <div><span>Source Episodes</span><strong>${formatCount(metadata.upstreamEpisodeCount)}</strong></div>
        <div><span>Local Manifests</span><strong>${metadata.manifestCount}</strong></div>
        <div><span>Rendered</span><strong>${metadata.processedCount}</strong></div>
        <div><span>Dry Runs</span><strong>${metadata.dryRunCount}</strong></div>
        <div><span>Lookback</span><strong>${deepDive.lookbackDays} days</strong></div>
        <div><span>Transcript Model</span><strong>${escapeHtml(metadata.transcriptionModel)}</strong></div>
        <div><span>Classifier Model</span><strong>${escapeHtml(metadata.classifierModel)}</strong></div>
        <div><span>Artwork</span><strong>${metadata.localArtworkUrl ? "generated" : metadata.sourceImageUrl ? "source" : "missing"}</strong></div>
      </div>
    </div>
  </section>`;
}

function renderPodcastControls(deepDive: DeepDive): string {
  return `<section class="panel controls">
    <div class="section-head"><h2>${escapeHtml(deepDive.name)} Controls</h2><span>Admin token required</span></div>
    <form data-admin-action="reprocess">
      <input type="hidden" name="scope" value="podcast">
      <input type="hidden" name="podcastSlug" value="${escapeHtml(deepDive.slug)}">
      <label>Lookback days <input name="lookbackDays" type="number" min="1" max="60" value="${deepDive.lookbackDays}"></label>
      <label>Max episodes <input name="maxEpisodes" type="number" min="1" max="100" value="${deepDive.config.effectiveProcessing.maxEpisodesPerRun}"></label>
      <label><input name="force" type="checkbox" checked> Force</label>
      <label><input name="reuseTranscript" type="checkbox" checked> Reuse transcript</label>
      <label><input name="skipArtwork" type="checkbox" checked> Skip artwork</label>
      <button type="submit">Enqueue podcast</button>
    </form>
    <form data-admin-action="tuning">
      <input type="hidden" name="scope" value="podcast">
      <input type="hidden" name="podcastSlug" value="${escapeHtml(deepDive.slug)}">
      <label>Confidence <input name="confidenceThreshold" type="number" min="0" max="1" step="0.01" value="${deepDive.config.effectiveProcessing.confidenceThreshold}"></label>
      <label>Fallback padding <input name="paddingSeconds" type="number" min="0" max="10" step="0.1" value="${deepDive.config.detection.paddingSeconds}"></label>
      <label>Before cut <input name="prePaddingSeconds" type="number" min="0" max="10" step="0.1" value="${deepDive.config.detection.prePaddingSeconds}"></label>
      <label>After cut <input name="postPaddingSeconds" type="number" min="0" max="10" step="0.1" value="${deepDive.config.detection.postPaddingSeconds}"></label>
      <label>Min cut <input name="minSegmentSeconds" type="number" min="0" max="120" step="0.5" value="${deepDive.config.detection.minSegmentSeconds}"></label>
      <label>Max cut <input name="maxSegmentSeconds" type="number" min="1" max="1200" step="1" value="${deepDive.config.detection.maxSegmentSeconds}"></label>
      <label><input name="markerToneEnabled" type="checkbox" ${deepDive.config.audio.jingle.enabled ? "checked" : ""}> Marker tone</label>
      <button type="submit">Save podcast tuning</button>
    </form>
  </section>`;
}

function renderEpisodeControls(podcastSlug: string, episode: UiEpisode): string {
  return `<section class="inline-controls">
    <form data-admin-action="reprocess">
      <input type="hidden" name="scope" value="episode">
      <input type="hidden" name="podcastSlug" value="${escapeHtml(podcastSlug)}">
      <input type="hidden" name="episodeKey" value="${escapeHtml(episode.episodeKey)}">
      <input type="hidden" name="force" value="true">
      <input type="hidden" name="skipArtwork" value="true">
      <input type="hidden" name="reuseTranscript" value="true">
      <button type="submit">Reprocess episode</button>
    </form>
    <form data-admin-action="reset-attempts">
      <input type="hidden" name="podcastSlug" value="${escapeHtml(podcastSlug)}">
      <input type="hidden" name="episodeKey" value="${escapeHtml(episode.episodeKey)}">
      <button type="submit">Reset attempts</button>
    </form>
  </section>`;
}

function renderAudioCompare(episode: UiEpisode): string {
  if (!episode.ui.sourceAudioUrl && !episode.ui.processedAudioUrl) return "";
  return `<section class="compare">
    ${episode.ui.sourceAudioUrl ? `<div class="audio-panel"><h3>Original</h3><audio data-role="source-audio" controls preload="none" src="${episode.ui.sourceAudioUrl}"></audio></div>` : ""}
    ${episode.ui.processedAudioUrl ? `<div class="audio-panel"><h3>Processed</h3><audio data-role="processed-audio" controls preload="none" src="${episode.ui.processedAudioUrl}"></audio></div>` : ""}
  </section>`;
}

function renderArtifactLinks(episode: UiEpisode): string {
  const base = `/assets/${episode.podcastSlug}/${episode.episodeKey}`;
  return `<section class="artifact-links">
    <a href="${base}/manifest.json">manifest JSON</a>
    <a href="${base}/transcript.json">transcript JSON</a>
    <a href="${base}/transcript.vtt">transcript VTT</a>
    <a href="${base}/chapters.json">chapters JSON</a>
  </section>`;
}

function renderAlignmentSummary(episode: UiEpisode): string {
  if (!episode.alignment) return "none";
  const words = episode.alignment.wordCount != null ? ` · ${episode.alignment.wordCount} words` : "";
  const cost = episode.alignment.costUsd != null ? ` · $${episode.alignment.costUsd.toFixed(6)}` : "";
  return escapeHtml(
    `${episode.alignment.provider}/${episode.alignment.model} · ${(episode.alignment.confidence * 100).toFixed(0)}% · ${episode.alignment.adjustedSegments} adjusted · max ${episode.alignment.maxAdjustmentSeconds}s${words}${cost}`
  );
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
  if (episode.chapters.length === 0 && !(episode.sourceChapters?.length)) return "";
  const processedDuration = episode.ui.processedDurationSeconds ?? episode.processedDurationSeconds;
  const chapters = [...episode.chapters].sort((a, b) => a.startTime - b.startTime).slice(0, 10);
  const sourceChapters = [...(episode.sourceChapters ?? [])].sort((a, b) => a.startTime - b.startTime).slice(0, 10);
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
  const sourceRows = sourceChapters
    .map(
      (chapter) => `<tr>
        <td><button data-jump-source="${chapter.startTime.toFixed(3)}">${formatSeconds(chapter.startTime)}</button></td>
        <td>${escapeHtml(chapter.title)}</td>
      </tr>`
    )
    .join("");
  return `<section class="audit-table">
    <h3>Final Chapters</h3>
    <table>
      <thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Topic</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      sourceRows
        ? `<details class="transcript" open><summary>Source chapters (${sourceChapters.length})</summary><table><thead><tr><th>Source Start</th><th>Publisher Topic</th></tr></thead><tbody>${sourceRows}</tbody></table></details>`
        : ""
    }
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

function renderCostDashboard(costs: CostSummary): string {
  return page(
    "Podcast Proxy Costs",
    `<header>
      <a href="/">Back</a>
      <h1>Cost Dashboard</h1>
      <p>${escapeHtml(costs.month)} · actual $${costs.actualUsd.toFixed(6)} / budget $${costs.monthlyBudgetUsd.toFixed(2)} · remaining $${costs.remainingUsd.toFixed(6)}</p>
    </header>
    <section class="panel meta">
      <div><span>Estimated</span><strong>$${costs.estimatedUsd.toFixed(6)}</strong></div>
      <div><span>Actual</span><strong>$${costs.actualUsd.toFixed(6)}</strong></div>
      <div><span>Remaining</span><strong>$${costs.remainingUsd.toFixed(6)}</strong></div>
      <div><span>LLM Calls</span><strong>${costs.llmCalls}</strong></div>
    </section>
    ${renderCostTable("By Podcast", costs.byPodcast, ["podcastSlug", "actualUsd", "estimatedUsd", "llmCalls", "episodes"])}
    ${renderCostTable("By Day", costs.byDay, ["day", "actualUsd", "estimatedUsd", "llmCalls", "failures"])}
    ${renderCostTable("By Model", costs.byModel, ["model", "actualUsd", "entries"])}
    ${renderCostTable("By Stage", costs.byStage, ["stage", "actualUsd", "entries"])}
    ${renderCostTable("Top Episodes", costs.byEpisode, ["podcastSlug", "episodeKey", "actualUsd", "estimatedUsd", "llmCalls"])}`
  );
}

function renderCostTable<T extends Record<string, unknown>>(title: string, rows: T[], keys: Array<keyof T & string>): string {
  const body = rows
    .map((row) => `<tr>${keys.map((key) => `<td>${escapeHtml(formatCostCell(row[key]))}</td>`).join("")}</tr>`)
    .join("");
  return `<section class="panel cost-table">
    <div class="section-head"><h2>${escapeHtml(title)}</h2></div>
    <table>
      <thead><tr>${keys.map((key) => `<th>${escapeHtml(formatCostHeader(key))}</th>`).join("")}</tr></thead>
      <tbody>${body || `<tr><td colspan="${keys.length}">No data yet.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function formatCostHeader(key: string): string {
  const labels: Record<string, string> = {
    podcastSlug: "Podcast",
    episodeKey: "Episode",
    actualUsd: "Actual",
    estimatedUsd: "Estimated",
    llmCalls: "LLM Calls",
    episodes: "Episodes",
    day: "Day",
    failures: "Failures",
    model: "Model",
    entries: "Entries",
    stage: "Stage"
  };
  return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatCostCell(value: unknown): string {
  return typeof value === "number" && !Number.isInteger(value) ? `$${value.toFixed(6)}` : String(value ?? "");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#65717d; --soft:#8a96a3; --line:#d7dde3; --bg:#f4f6f8; --panel:#ffffff; --panel-2:#fafbfc; --accent:#0f766e; --accent-ink:#115e59; --accent-soft:#e8f3f1; --red:#b42318; --amber:#b45309; --green:#166534; --blue:#1d4ed8; --shadow:0 14px 36px rgba(23,32,42,.07); }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; font:14px/1.48 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
    body > header, body > main, body > section { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:22px; }
    a { color:var(--accent-ink); text-decoration:none; }
    a:hover { text-decoration:underline; }
    h1, h2, h3, p, dl, dd { margin:0; }
    h1 { font-size:30px; line-height:1.12; font-weight:760; }
    h2 { font-size:18px; line-height:1.2; font-weight:720; }
    h3 { font-size:14px; line-height:1.25; font-weight:720; }
    button, input, select { font:inherit; }
    code { color:#344054; white-space:normal; overflow-wrap:anywhere; }
    .app-header { display:flex; justify-content:space-between; gap:18px; align-items:flex-end; padding-top:26px; padding-bottom:12px; }
    .app-header p { margin-top:7px; color:var(--muted); overflow-wrap:anywhere; font-size:13px; }
    .app-header p.feed-url { font-size:12px; color:var(--soft); }
    .eyebrow { color:var(--soft); font-size:11px; font-weight:740; text-transform:uppercase; }
    .back-link { display:inline-block; margin-bottom:10px; }
    .header-actions, .link-row, .artifact-links { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .header-actions a, .link-row a, .artifact-links a { border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--accent-ink); padding:7px 10px; min-height:34px; display:inline-flex; align-items:center; }
    .link-row a, .artifact-links a { font-size:12px; font-weight:650; padding:5px 9px; min-height:30px; }
    .status-dot { width:9px; height:9px; display:inline-block; margin-right:8px; border-radius:50%; background:var(--soft); vertical-align:1px; }
    .status-dot.running { background:var(--green); box-shadow:0 0 0 4px rgba(22,101,52,.1); }
    .panel, .episode, .podcast-card { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); }
    .home-stack { padding-top:8px; padding-bottom:0; }
    .section-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; }
    .section-head span { color:var(--muted); font-size:12px; }
    .podcasts-panel { padding:18px; }
    .podcast-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-top:14px; }
    .podcast-card { box-shadow:none; padding:16px; display:grid; gap:14px; min-width:0; transition:border-color .12s; }
    .podcast-card:hover { border-color:#b8c4ce; }
    .podcast-card-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .podcast-card h3 { font-size:15px; font-weight:740; letter-spacing:-.01em; }
    .podcast-card p { margin-top:5px; color:var(--muted); font-size:13px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:10px; }
    .metric-grid.compact { grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px 12px; }
    .metric-grid div, .meta div, .overview-stats div { min-width:0; border-top:1px solid var(--line); padding-top:8px; }
    dt, .meta span, .overview-stats span { display:block; color:var(--soft); font-size:11px; font-weight:700; text-transform:uppercase; }
    dd, .overview-stats strong, .meta strong { display:block; margin-top:3px; min-width:0; overflow-wrap:anywhere; }
    .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; }
    .meta code { display:block; margin-top:4px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
    .table-panel, .queue, .cost-table, .audit-table, details.transcript { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    .audit-table, details.transcript { scroll-padding-left:8px; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:10px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--soft); font-size:11px; font-weight:750; text-transform:uppercase; }
    tbody tr:hover td { background:#fbfcfd; }
    .podcast-overview { display:grid; grid-template-columns:156px minmax(0,1fr); gap:20px; align-items:start; margin-bottom:14px; }
    .podcast-art { width:156px; aspect-ratio:1; object-fit:cover; border:1px solid var(--line); border-radius:10px; background:#fff; box-shadow:0 2px 8px rgba(23,32,42,.08); }
    .placeholder-art { display:flex; align-items:center; justify-content:center; color:var(--red); font-weight:800; text-transform:uppercase; border-color:rgba(180,35,24,.35); }
    .podcast-overview-body { min-width:0; }
    .podcast-overview p { margin-top:10px; color:var(--muted); max-width:88ch; line-height:1.6; font-size:13px; }
    .overview-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:10px 14px; margin-top:16px; }
    .controls { margin:0 auto 14px; padding:18px; display:grid; gap:14px; }
    .controls form, .inline-controls { display:flex; flex-wrap:wrap; gap:10px; align-items:end; }
    .controls label { display:flex; flex-direction:column; gap:5px; color:var(--soft); font-size:11px; font-weight:700; text-transform:uppercase; }
    .controls input, .controls select { min-height:36px; border:1px solid var(--line); border-radius:6px; padding:6px 9px; background:#fff; color:var(--ink); }
    .controls input:focus, .controls select:focus, button:focus-visible, .timeline:focus-visible { outline:2px solid rgba(15,118,110,.32); outline-offset:2px; }
    .controls label:has(input[type="checkbox"]) { flex-direction:row; align-items:center; gap:7px; text-transform:none; color:var(--ink); font-size:13px; font-weight:500; }
    .controls button, .inline-controls button, .cut-list button, .transcript button, .audit-table button { min-height:34px; border:1px solid rgba(15,118,110,.32); border-radius:6px; background:var(--accent-soft); color:var(--accent-ink); padding:6px 10px; cursor:pointer; }
    .inline-controls { margin-top:12px; }
    .artifact-links { margin-top:12px; padding:0; }
    .episodes { display:grid; gap:14px; min-width:0; padding-top:0; }
    .episode { padding:18px; min-width:0; }
    .episode > * { min-width:0; }
    .episode-head { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
    .episode-head h2 { margin-top:2px; font-size:16px; }
    .episode-metrics { margin-top:14px; }
    ul, ol { margin:0; padding-left:20px; }
    .queue { margin:0 auto 14px; padding:18px; }
    .queue table { min-width:1040px; font-size:12px; margin-top:10px; }
    .queue code { color:var(--muted); }
    .queue-cards { display:none; }
    .queue-card { border:1px solid var(--line); border-radius:8px; padding:14px; background:#fff; display:grid; gap:10px; }
    .queue-card-head { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .queue-card h3 { font-size:14px; font-weight:720; }
    .queue-card h3 a { color:var(--ink); }
    .queue-card h3 a:hover { color:var(--accent-ink); }
    .queue-error { margin-top:10px; padding:8px 10px; background:rgba(180,35,24,.05); border-left:3px solid rgba(180,35,24,.28); border-radius:0 5px 5px 0; }
    .queue-error code { display:block; font-size:12px; color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; }
    .cost-table { margin:14px auto; padding:18px; }
    .cost-table table { min-width:680px; margin-top:10px; }
    .state { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:6px; padding:3px 7px; color:var(--muted); background:#fff; white-space:nowrap; font-size:12px; }
    .state.running, .state.queued { border-color:rgba(15,118,110,.35); color:var(--accent-ink); background:rgba(15,118,110,.08); }
    .state.completed { border-color:rgba(22,101,52,.35); color:var(--green); background:rgba(22,101,52,.08); }
    .state.failed, .state.waiting-for-credits, .state.dry-run { border-color:rgba(180,83,9,.35); color:var(--amber); background:rgba(180,83,9,.08); }
    .state.quarantined { border-color:rgba(180,35,24,.35); color:var(--red); background:rgba(180,35,24,.08); }
    .activity { margin:0 auto 14px; padding:18px; }
    .activity ol { display:grid; gap:0; padding-left:0; list-style:none; margin-top:12px; }
    .activity li { display:grid; grid-template-columns:170px minmax(120px,1fr) minmax(84px,130px) minmax(120px,1.4fr); gap:8px; align-items:start; border-top:1px solid var(--line); padding:9px 0; }
    .activity li:first-child { border-top:0; padding-top:0; }
    .activity li.warn strong { color:var(--amber); }
    .activity li.error strong { color:var(--red); }
    .activity time, .activity span, .activity em { color:var(--muted); font-style:normal; }
    .activity code { grid-column:1 / -1; color:var(--muted); font-size:12px; }
    audio { width:100%; height:34px; }
    .compare { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; max-width:100%; margin-top:14px; }
    .audio-panel { border:1px solid var(--line); border-radius:8px; padding:10px; background:var(--panel-2); }
    .audio-panel h3 { color:var(--soft); font-size:11px; text-transform:uppercase; margin-bottom:8px; }
    .timeline-block { max-width:100%; margin-top:16px; padding:14px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); }
    .timeline-head { display:flex; justify-content:space-between; gap:12px; align-items:end; }
    .timeline-head h3 { font-size:14px; color:var(--ink); text-transform:none; }
    .timeline-head span, .timeline-label, .legend { color:var(--muted); font-size:12px; }
    .timeline-label { display:flex; justify-content:space-between; margin-top:11px; }
    .timeline { position:relative; height:34px; border:1px solid #c8d1da; border-radius:6px; background:#edf1f4; overflow:hidden; cursor:pointer; box-shadow:inset 0 1px 2px rgba(23,32,42,.05); }
    .timeline::after { content:""; position:absolute; inset:0; pointer-events:none; border:2px solid transparent; }
    .timeline:hover::after { border-color:rgba(15,118,110,.3); }
    .timeline.processed { background:#eef5f3; }
    .cut { position:absolute; top:0; bottom:0; padding:0; background:rgba(180,35,24,.72); border-left:1px solid rgba(127,29,29,.85); border-right:1px solid rgba(127,29,29,.85); pointer-events:none; }
    .tick { position:absolute; top:0; bottom:0; width:4px; padding:0; background:rgba(15,118,110,.9); transform:translateX(-1px); pointer-events:none; }
    .splice { position:absolute; top:0; bottom:0; width:3px; background:rgba(29,78,216,.9); pointer-events:none; }
    .legend { display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-top:8px; }
    .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
    .legend .red { background:rgba(180,35,24,.72); }
    .legend .green { background:rgba(15,118,110,.9); }
    .legend .blue { background:rgba(29,78,216,.9); }
    .cut-list { display:grid; gap:8px; margin:10px 0 0; padding-left:0; list-style:none; }
    .cut-list li { display:grid; grid-template-columns:auto auto 1fr auto; gap:8px; align-items:center; padding:8px; border:1px solid var(--line); border-radius:6px; background:#fff; }
    .cut-list small { color:var(--muted); white-space:nowrap; }
    .audit-table { max-width:100%; padding:0; margin-top:14px; }
    .audit-table table { min-width:920px; font-size:12px; }
    .audit-table th, .audit-table td { padding:8px 10px; }
    .audit-table td:first-child, .audit-table td:nth-child(2), .audit-table td:nth-child(3), .audit-table td:nth-child(4), .audit-table td:nth-child(5), .audit-table td:nth-child(6) { white-space:nowrap; }
    .transcript-wrap { max-width:100%; padding:0; margin-top:16px; }
    details.transcript { max-width:100%; margin-top:10px; border:1px solid var(--line); border-radius:8px; padding:11px; background:#fff; }
    summary { cursor:pointer; color:var(--accent-ink); font-weight:700; }
    .transcript table { min-width:880px; margin-top:10px; font-size:12px; }
    .transcript td:first-child, .transcript td:nth-child(2), .transcript td:nth-child(3) { white-space:nowrap; color:var(--muted); width:74px; }
    .removed-row td { background:rgba(180,35,24,.08); }
    .removed-row td:last-child { text-decoration:line-through; color:#7f1d1d; }
    .partial-row td { background:rgba(180,83,9,.08); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:6px; padding:2px 7px; color:var(--muted); font-size:11px; }
    .pill.danger { border-color:rgba(180,35,24,.35); color:var(--red); background:rgba(180,35,24,.08); }
    .pill.warn { border-color:rgba(180,83,9,.35); color:var(--amber); background:rgba(180,83,9,.08); }
    .empty { color:var(--muted); }
    @media (max-width: 760px) {
      body > header, body > main, body > section { width:calc(100% - 20px); padding:14px; }
      .app-header { align-items:flex-start; flex-direction:column; padding-top:18px; }
      .header-actions a, .link-row a, .artifact-links a { width:auto; min-height:40px; }
      h1 { font-size:24px; }
      .section-head, .episode-head, .timeline-head { align-items:flex-start; flex-direction:column; }
      .podcasts-panel, .controls, .queue, .activity, .cost-table, .episode { padding:14px; }
      .podcast-grid, .metric-grid, .metric-grid.compact, .meta, .overview-stats { grid-template-columns:1fr; }
      .controls form, .inline-controls { display:grid; grid-template-columns:1fr; align-items:stretch; }
      .controls label, .controls input, .controls select, .controls button, .inline-controls button { width:100%; min-height:42px; }
      .controls label:has(input[type="checkbox"]) { min-height:42px; justify-content:flex-start; }
      .controls label:has(input[type="checkbox"]) input { width:auto; min-height:auto; flex:0 0 auto; }
      .podcast-overview { grid-template-columns:1fr; }
      .podcast-art { width:min(160px, 100%); border-radius:8px; }
      .episode-head h2 { font-size:15px; }
      .compare { grid-template-columns:1fr; }
      .activity li { grid-template-columns:1fr; }
      .queue-table { display:none; }
      .queue-cards { display:grid; gap:10px; margin-top:12px; }
      .cut-list li { grid-template-columns:1fr 1fr; }
      .cut-list span, .cut-list small { grid-column:1 / -1; }
    }
  </style>
  <script>
    function formatLocalTimes() {
      const formatters = {
        activity: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        full: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })
      };
      document.querySelectorAll("time[data-local-time]").forEach((node) => {
        const raw = node.getAttribute("datetime");
        if (!raw) return;
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return;
        const mode = node.getAttribute("data-local-time") === "activity" ? "activity" : "full";
        node.textContent = formatters[mode].format(date);
        node.title = date.toISOString();
      });
    }

    function adminToken() {
      const existing = window.localStorage.getItem("podcastoorAdminToken");
      const token = existing || window.prompt("Admin token");
      if (token) window.localStorage.setItem("podcastoorAdminToken", token);
      return token;
    }

    function formPayload(form) {
      const data = new FormData(form);
      const payload = {};
      for (const [key, value] of data.entries()) {
        if (value === "") continue;
        payload[key] = value;
      }
      for (const input of form.querySelectorAll("input[type='checkbox']")) {
        if (input.name) payload[input.name] = input.checked;
      }
      return payload;
    }

    async function postAdminJson(url, payload) {
      const token = adminToken();
      if (!token) return;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify(payload)
      });
      const text = await response.text();
      if (!response.ok) {
        window.alert(text || response.statusText);
        return;
      }
      window.alert("Queued");
      window.location.reload();
    }

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

    document.addEventListener("submit", (event) => {
      const form = event.target.closest?.("form[data-admin-action]");
      if (!form) return;
      event.preventDefault();
      const action = form.getAttribute("data-admin-action");
      const payload = formPayload(form);
      const url = action === "tuning"
        ? "/api/runtime-overrides/tuning"
        : action === "reset-attempts"
          ? "/api/actions/reset-attempts"
          : "/api/actions/reprocess";
      postAdminJson(url, payload).catch((error) => window.alert(String(error)));
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", formatLocalTimes, { once: true });
    } else {
      formatLocalTimes();
    }
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

function formatCount(value: number | undefined): string {
  return value == null ? "unknown" : new Intl.NumberFormat("en").format(value);
}

function renderLocalTime(value: string | undefined | null, mode: "activity" | "full" = "full"): string {
  if (!value) return "unknown";
  const date = new Date(value);
  const datetime = Number.isNaN(date.getTime()) ? value : date.toISOString();
  return `<time datetime="${escapeHtml(datetime)}" data-local-time="${mode}">${escapeHtml(value)}</time>`;
}

function authorizeAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = config.admin.token || process.env.PODCAST_PROXY_ADMIN_TOKEN;
  if (!expected) {
    reply.code(403);
    void reply.send({ error: "admin token is not configured" });
    return false;
  }
  const body = actionBody(request.body);
  const headerToken = Array.isArray(request.headers["x-admin-token"]) ? request.headers["x-admin-token"][0] : request.headers["x-admin-token"];
  const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
  const token = headerToken || authorization?.replace(/^Bearer\s+/i, "") || body.adminToken;
  if (String(token ?? "") !== expected) {
    reply.code(401);
    void reply.send({ error: "invalid admin token" });
    return false;
  }
  return true;
}

function actionBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function parseScope(value: unknown): ManualReprocessScope | undefined {
  return value === "episode" || value === "podcast" || value === "global" || value === "failed" ? value : undefined;
}

function parseTuning(body: Record<string, unknown>): RuntimeTuning {
  const confidenceThreshold = numberValue(body.confidenceThreshold);
  const paddingSeconds = numberValue(body.paddingSeconds);
  const prePaddingSeconds = numberValue(body.prePaddingSeconds);
  const postPaddingSeconds = numberValue(body.postPaddingSeconds);
  const minSegmentSeconds = numberValue(body.minSegmentSeconds);
  const maxSegmentSeconds = numberValue(body.maxSegmentSeconds);
  const markerToneEnabled = boolValue(body.markerToneEnabled);
  return {
    ...(confidenceThreshold != null ? { processing: { confidenceThreshold } } : {}),
    ...(paddingSeconds != null || prePaddingSeconds != null || postPaddingSeconds != null || minSegmentSeconds != null || maxSegmentSeconds != null
      ? {
          detection: {
            ...(paddingSeconds != null ? { paddingSeconds } : {}),
            ...(prePaddingSeconds != null ? { prePaddingSeconds } : {}),
            ...(postPaddingSeconds != null ? { postPaddingSeconds } : {}),
            ...(minSegmentSeconds != null ? { minSegmentSeconds } : {}),
            ...(maxSegmentSeconds != null ? { maxSegmentSeconds } : {})
          }
        }
      : {}),
    ...(markerToneEnabled != null ? { audio: { jingle: { enabled: markerToneEnabled } } } : {})
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "1", "on", "yes"].includes(value.toLowerCase());
  return undefined;
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
    prePaddingSeconds: config.detection.prePaddingSeconds,
    postPaddingSeconds: config.detection.postPaddingSeconds,
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

function llmModelLabel(episode: UiEpisode, purpose: LlmUsage["purpose"]): string {
  const models = Array.from(new Set((episode.llm ?? []).filter((usage) => usage.purpose === purpose).map((usage) => usage.model).filter(Boolean)));
  return models.length ? models.join(", ") : "none recorded";
}

function formatActivityDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}
