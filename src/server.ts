import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig, EpisodeManifest } from "./types.js";
import { loadConfig, resolvePodcastConfig } from "./config.js";
import { fetchFeed, parseFeed, rewriteFeed } from "./feed.js";
import { episodePaths, podcastAssetPaths, readManifest } from "./storage.js";
import { absoluteUrl, pathExists, readJson } from "./utils.js";
import { ensureCompatiblePodcastArtwork } from "./artwork.js";
import { getAutomationState, startAutomation } from "./automation.js";
import { getPodcastDeepDive, listPodcastSummaries } from "./library.js";
import { readRecentActivity } from "./activity.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { enqueueManualReprocess, listQueueEpisodes, resetQueueAttempts, type ManualReprocessScope } from "./queue.js";
import { applyRuntimeOverridesObject, loadRuntimeOverrides, updateRuntimeTuning, type RuntimeTuning } from "./runtime-overrides.js";
import { summarizeCosts } from "./costs.js";
import { buildCostView, buildDashboard, buildEpisodeView, buildQueueRows, buildTuningView } from "./viewmodel.js";
import { addPodcast, uniqueSlug } from "./podcasts-store.js";

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

  app.get("/api/podcasts", async () => ({
    podcasts: await listPodcastSummaries(config),
    automation: getAutomationState()
  }));

  app.get("/api/activity", async () => ({
    activity: await readRecentActivity(config, 100),
    automation: getAutomationState()
  }));

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

  app.get("/api/dashboard", async () => buildDashboard(config));

  app.get("/api/queue-view", async () => ({
    queue: await buildQueueRows(config),
    automation: getAutomationState()
  }));

  app.get("/api/cost-view", async () => buildCostView(config));

  app.get("/api/tuning", async () => buildTuningView(config));

  app.get("/api/podcasts/:podcastSlug/episodes/:episodeKey", async (request, reply) => {
    const { podcastSlug, episodeKey } = request.params as { podcastSlug: string; episodeKey: string };
    const episode = await buildEpisodeView(config, podcastSlug, episodeKey);
    if (!episode) {
      reply.code(404);
      return { error: "episode not found" };
    }
    return episode;
  });

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

  app.post("/api/actions/add-feed", async (request, reply) => {
    if (!authorizeAdmin(config, request, reply)) return reply;
    const body = actionBody(request.body);
    const name = stringValue(body.name);
    const feedUrl = stringValue(body.feedUrl);
    if (!name || !feedUrl) {
      reply.code(400);
      return { error: "name and feedUrl are required" };
    }
    try {
      const parsed = new URL(feedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      reply.code(400);
      return { error: "feedUrl must be a valid http(s) URL" };
    }
    const slug = uniqueSlug(new Set(Object.keys(config.podcasts)), stringValue(body.slug) ?? name);
    await addPodcast(config, { slug, name, feedUrl });
    config.podcasts[slug] = { name, feedUrl };
    return { ok: true, slug };
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

  registerWebApp(app);

  return app;
}

const NON_APP_PREFIXES = ["/api", "/audio", "/assets", "/feeds", "/health", "/metrics"];

function resolveWebDist(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(process.cwd(), "web/dist"), path.resolve(here, "../../web/dist"), path.resolve(here, "../web/dist")];
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
}

function registerWebApp(app: ReturnType<typeof Fastify>): void {
  const webDist = resolveWebDist();
  if (!webDist) {
    app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
      reply.code(404).send({ error: "not found", hint: "web UI is not built; run `npm run build:web` or use the Vite dev server" });
    });
    return;
  }
  void app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "GET" && !NON_APP_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });
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
