import type { AppConfig, EpisodeManifest, Transcript } from "./types.js";
import { listManifests, readLocalArtworkUrl } from "./library.js";
import { episodePaths, readManifest } from "./storage.js";
import { listQueueEpisodes, type QueueEpisodeState } from "./queue.js";
import { summarizeCosts } from "./costs.js";
import { readRecentActivity } from "./activity.js";
import { loadRuntimeOverrides } from "./runtime-overrides.js";
import { getAutomationState } from "./automation.js";
import { readJson } from "./utils.js";
import { resolvePodcastConfig } from "./config.js";
import { durationAfterEdits, mapOriginalToProcessed, normalizeSegments, removalSegments, type Segment } from "./timeline.js";

const FALLBACK_PALETTE = ["#e8743a", "#9c6dd8", "#6b9bb8", "#d8a23f", "#e85a47", "#5ab886", "#8492a8", "#c66b4e"];

type PodcastStatus = "ok" | "warn" | "fail" | "run";

interface DemoStats {
  episodes?: number;
  processed?: number;
  failed?: number;
  quarantined?: number;
  savedSeconds?: number;
  avgAdsPct?: number;
  spend30dUsd?: number;
  latestRelative?: string;
  status?: PodcastStatus;
  overrideNote?: string;
}

interface SeededMeta {
  host?: string;
  color?: string;
  description?: string;
  demo?: DemoStats;
}

export interface PodcastCard {
  slug: string;
  name: string;
  host: string;
  color: string;
  artworkUrl?: string;
  status: PodcastStatus;
  episodes: number;
  processed: number;
  failed: number;
  quarantined: number;
  savedSeconds: number;
  sourceSeconds: number;
  avgAdsPct: number;
  spend30dUsd: number;
  latestRelative: string;
  lastEpisodeTitle: string;
  subscriptionUrl: string;
}

export interface ActivityRow {
  at: string;
  time: string;
  podcastSlug: string;
  episodeNumber: string;
  episodeTitle: string;
  stage: string;
  message: string;
  outcome: "ok" | "info" | "warn" | "fail";
}

export interface DashboardView {
  kpis: {
    podcasts: number;
    episodes: number;
    processed: number;
    failed: number;
    quarantined: number;
    savedSeconds: number;
    avgAdsPct: number;
    costToday: number;
    costTodayBudget: number;
    queueQueued: number;
    queueRunning: number;
  };
  podcasts: PodcastCard[];
  activity: ActivityRow[];
  cost: { today: number; todayBudget: number; daily: number[] };
  queueCounts: Record<string, number>;
  automation: ReturnType<typeof getAutomationState>;
}

export interface QueueRow {
  id: string;
  podcastSlug: string;
  podcastTitle: string;
  podcastColor: string;
  episodeTitle: string;
  state: QueueEpisodeState;
  stage: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  model: string;
}

export interface CostView {
  month: string;
  today: number;
  todayBudget: number;
  monthTotal: number;
  monthBudget: number;
  projected: number;
  perEpisode: number;
  daily: number[];
  byProvider: Array<{ name: string; stage: string; usd: number; share: number; calls: number; units: string }>;
  byPodcast: Array<{ slug: string; title: string; color: string; usd: number; share: number }>;
  warning?: { projectedPct: number; topPodcast: string; topPodcastShare: number };
}

export interface TuningView {
  global: { confidence: number; prePad: number; postPad: number; minCut: number; maxCut: number; markerTone: boolean; reuseTranscript: boolean };
  perPodcast: Array<{ slug: string; title: string; color: string; confidence: number; prePad: number; postPad: number; markerTone: boolean; notes: string }>;
  defaultsCount: number;
  adminConfigured: boolean;
}

export interface EpisodeView {
  podcast: string;
  podcastSlug: string;
  podcastColor: string;
  podcastArtworkUrl?: string;
  episodeKey: string;
  number: number;
  title: string;
  pubAt: string;
  status: string;
  durSource: number;
  durProc: number;
  saved: number;
  cuts: number;
  marks: number;
  cost: number;
  decisions: Array<{
    i: number;
    src0: number;
    src1: number;
    proc: number;
    dur: number;
    action: "remove" | "mark";
    conf: number;
    who: string;
    reason: string;
    method: string;
    source: string;
    text?: string;
    alignment?: {
      startSegmentIndex?: number;
      endSegmentIndex?: number;
      method?: string;
      startAnchorText?: string;
      endAnchorText?: string;
    };
  }>;
  chaptersSource: Array<{ t: number; label: string }>;
  chaptersFinal: Array<{ t: number; label: string }>;
  transcript: Array<{ src: number; srcEnd: number; proc: number | null; procEnd: number | null; status: "kept" | "removed" | "partial"; text: string }>;
  links: { manifest: string; transcriptJson: string; transcriptVtt: string; chaptersJson: string; sourceAudio: string; processedAudio: string };
}

function seededMeta(config: AppConfig, slug: string): SeededMeta {
  const podcast = config.podcasts[slug] as unknown as Record<string, unknown> | undefined;
  if (!podcast) return {};
  return {
    host: typeof podcast.host === "string" ? podcast.host : undefined,
    color: typeof podcast.accentColor === "string" ? podcast.accentColor : undefined,
    description: typeof podcast.description === "string" ? podcast.description : undefined,
    demo: podcast.demo as DemoStats | undefined,
  };
}

function colorFor(config: AppConfig, slug: string): string {
  const meta = seededMeta(config, slug);
  if (meta.color) return meta.color;
  const index = Object.keys(config.podcasts).indexOf(slug);
  return FALLBACK_PALETTE[(index < 0 ? 0 : index) % FALLBACK_PALETTE.length];
}

function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clockTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 19);
}

function deriveStatus(failed: number, quarantined: number, running: boolean): PodcastStatus {
  if (running) return "run";
  if (failed > 0) return "fail";
  if (quarantined > 0) return "warn";
  return "ok";
}

function removeCount(manifest: EpisodeManifest): number {
  return manifest.decisions.filter((d) => d.action === "remove").length;
}

function markCount(manifest: EpisodeManifest): number {
  return manifest.decisions.filter((d) => d.action === "mark-only").length;
}

function sourceSecondsForManifest(manifest: EpisodeManifest): number {
  return manifest.audio.sourceDurationSeconds ?? manifest.originalDurationSeconds ?? 0;
}

function savedSecondsForManifest(manifest: EpisodeManifest): number {
  return Math.max(0, manifest.audio.removedSeconds ?? 0);
}

function seconds3(value: number): number {
  return Number(value.toFixed(3));
}

async function buildPodcastCards(config: AppConfig): Promise<PodcastCard[]> {
  const queue = await listQueueEpisodes(config);
  const cards: PodcastCard[] = [];
  for (const slug of Object.keys(config.podcasts)) {
    const podcast = config.podcasts[slug];
    const meta = seededMeta(config, slug);
    const manifests = (await listManifests(config, slug)).sort((a, b) => Date.parse(b.pubDate ?? b.generatedAt) - Date.parse(a.pubDate ?? a.generatedAt));
    const latest = manifests[0];
    const queueForPodcast = queue.filter((q) => q.podcastSlug === slug);
    const running = queueForPodcast.some((q) => q.state === "running");

    const derivedFailed = queueForPodcast.filter((q) => q.state === "failed" || q.state === "waiting-for-credits").length;
    const derivedQuar = queueForPodcast.filter((q) => q.state === "quarantined").length;
    const completed = manifests.filter((m) => m.audio.status === "completed");
    const savedSeconds = completed.reduce((sum, m) => sum + savedSecondsForManifest(m), 0);
    const sourceSeconds = completed.reduce((sum, m) => sum + sourceSecondsForManifest(m), 0);
    const avgAds = sourceSeconds > 0 ? (savedSeconds / sourceSeconds) * 100 : 0;

    const demo = meta.demo;
    cards.push({
      slug,
      name: podcast.name,
      host: meta.host ?? "—",
      color: colorFor(config, slug),
      artworkUrl: await readLocalArtworkUrl(config, slug),
      status: demo?.status ?? deriveStatus(derivedFailed, derivedQuar, running),
      episodes: demo?.episodes ?? manifests.length,
      processed: demo?.processed ?? completed.length,
      failed: demo?.failed ?? derivedFailed,
      quarantined: demo?.quarantined ?? derivedQuar,
      savedSeconds: demo?.savedSeconds ?? savedSeconds,
      sourceSeconds,
      avgAdsPct: demo?.avgAdsPct ?? Number(avgAds.toFixed(1)),
      spend30dUsd: demo?.spend30dUsd ?? 0,
      latestRelative: demo?.latestRelative ?? relativeTime(latest?.pubDate),
      lastEpisodeTitle: latest?.title ?? "—",
      subscriptionUrl: `${config.server.publicBaseUrl}/feeds/${slug}.xml`,
    });
  }
  return cards;
}

function dayKey(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function buildDashboard(config: AppConfig): Promise<DashboardView> {
  const [cards, queue, costs, activityEvents] = await Promise.all([
    buildPodcastCards(config),
    listQueueEpisodes(config),
    summarizeCosts(config),
    readRecentActivity(config, 12),
  ]);

  const byDay = new Map(costs.byDay.map((row) => [row.day, row.actualUsd]));
  const today = byDay.get(dayKey(0)) ?? 0;
  const daily: number[] = [];
  for (let i = 25; i >= 0; i--) daily.push(Number((byDay.get(dayKey(i)) ?? 0).toFixed(2)));

  const queueCounts: Record<string, number> = {};
  for (const job of queue) queueCounts[job.state] = (queueCounts[job.state] ?? 0) + 1;

  const activity: ActivityRow[] = activityEvents.map((event) => {
    const details = (event.details ?? {}) as Record<string, unknown>;
    const outcome = (details.outcome as ActivityRow["outcome"]) ?? (event.level === "error" ? "fail" : event.level === "warn" ? "warn" : "info");
    return {
      at: event.at,
      time: clockTime(event.at),
      podcastSlug: event.podcastSlug ?? "—",
      episodeNumber: String(details.episodeNumber ?? ""),
      episodeTitle: event.episodeTitle ?? String(details.episodeTitle ?? ""),
      stage: String(details.stage ?? "—"),
      message: event.message,
      outcome,
    };
  });

  const todayBudget = config.costs.dailyBudgetUsd ?? 25;
  const savedSeconds = cards.reduce((sum, c) => sum + c.savedSeconds, 0);
  const sourceSeconds = cards.reduce((sum, c) => sum + c.sourceSeconds, 0);
  const avgAds = sourceSeconds > 0 ? (savedSeconds / sourceSeconds) * 100 : 0;

  return {
    kpis: {
      podcasts: cards.length,
      episodes: cards.reduce((sum, c) => sum + c.episodes, 0),
      processed: cards.reduce((sum, c) => sum + c.processed, 0),
      failed: cards.reduce((sum, c) => sum + c.failed, 0),
      quarantined: cards.reduce((sum, c) => sum + c.quarantined, 0),
      savedSeconds,
      avgAdsPct: Number(avgAds.toFixed(1)),
      costToday: Number(today.toFixed(2)),
      costTodayBudget: todayBudget,
      queueQueued: queueCounts.queued ?? 0,
      queueRunning: queueCounts.running ?? 0,
    },
    podcasts: cards,
    activity,
    cost: { today: Number(today.toFixed(2)), todayBudget, daily },
    queueCounts,
    automation: getAutomationState(),
  };
}

export { buildPodcastCards };

export async function buildQueueRows(config: AppConfig): Promise<QueueRow[]> {
  const queue = await listQueueEpisodes(config);
  return queue.map((job) => {
    const podcast = config.podcasts[job.podcastSlug];
    const model = [...job.history].reverse().find((h) => h.model)?.model ?? "—";
    return {
      id: job.id,
      podcastSlug: job.podcastSlug,
      podcastTitle: podcast?.name ?? job.podcastSlug,
      podcastColor: colorFor(config, job.podcastSlug),
      episodeTitle: job.episodeTitle,
      state: job.state,
      stage: job.currentStage,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastAttemptAt: job.lastAttemptAt,
      nextRetryAt: job.nextRetryAt,
      lastError: job.lastError,
      model,
    };
  });
}

const PROVIDER_LABELS: Record<string, { name: string; stage: string }> = {
  "gpt-4o-mini": { name: "OpenAI GPT-4o-mini", stage: "detect+review" },
  "whisper-large-v3": { name: "Whisper Large v3", stage: "transcribe" },
  "gpt-4o": { name: "GPT-4o", stage: "chapters" },
  AssemblyAI: { name: "AssemblyAI fallback", stage: "transcribe" },
  elevenlabs: { name: "ElevenLabs (markers)", stage: "render" },
};

async function meanEpisodeCost(config: AppConfig): Promise<number> {
  let total = 0;
  let count = 0;
  for (const slug of Object.keys(config.podcasts)) {
    for (const manifest of await listManifests(config, slug)) {
      if (manifest.audio.status !== "completed") continue;
      total += manifest.costs.actualUsd;
      count += 1;
    }
  }
  return count ? Number((total / count).toFixed(2)) : 0;
}

export async function buildCostView(config: AppConfig): Promise<CostView> {
  const costs = await summarizeCosts(config);
  const monthTotal = costs.actualUsd;
  const byDay = new Map(costs.byDay.map((row) => [row.day, row.actualUsd]));
  const today = Number((byDay.get(dayKey(0)) ?? 0).toFixed(2));
  const daily: number[] = [];
  for (let i = 25; i >= 0; i--) daily.push(Number((byDay.get(dayKey(i)) ?? 0).toFixed(2)));

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projected = dayOfMonth > 0 ? Number(((monthTotal / dayOfMonth) * daysInMonth).toFixed(2)) : monthTotal;

  const byProvider = costs.byModel.map((row) => {
    const info = PROVIDER_LABELS[row.model] ?? { name: row.model, stage: "—" };
    const share = monthTotal ? row.actualUsd / monthTotal : 0;
    const units = info.stage === "transcribe" ? `${Math.round(row.actualUsd / 0.006)} audio-min` : info.stage === "render" ? `${row.entries} calls` : `${Math.round(row.actualUsd * 800)} tok`;
    return { name: info.name, stage: info.stage, usd: Number(row.actualUsd.toFixed(2)), share: Number(share.toFixed(2)), calls: row.entries, units };
  });

  const byPodcast = costs.byPodcast.map((row) => ({
    slug: row.podcastSlug,
    title: config.podcasts[row.podcastSlug]?.name ?? row.podcastSlug,
    color: colorFor(config, row.podcastSlug),
    usd: Number(row.actualUsd.toFixed(2)),
    share: monthTotal ? Number((row.actualUsd / monthTotal).toFixed(3)) : 0,
  }));

  const monthBudget = costs.monthlyBudgetUsd;
  const projectedPct = monthBudget ? projected / monthBudget : 0;
  const top = byPodcast[0];

  return {
    month: costs.month,
    today,
    todayBudget: config.costs.dailyBudgetUsd ?? 25,
    monthTotal: Number(monthTotal.toFixed(2)),
    monthBudget,
    projected,
    perEpisode: await meanEpisodeCost(config),
    daily,
    byProvider,
    byPodcast,
    warning: top ? { projectedPct: Number(projectedPct.toFixed(2)), topPodcast: top.title, topPodcastShare: monthTotal ? Number((top.usd / monthTotal).toFixed(2)) : 0 } : undefined,
  };
}

export async function buildTuningView(config: AppConfig): Promise<TuningView> {
  const overrides = await loadRuntimeOverrides(config);
  const g = overrides.global ?? {};
  const global = {
    confidence: g.processing?.confidenceThreshold ?? config.processing.confidenceThreshold,
    prePad: g.detection?.prePaddingSeconds ?? config.detection.prePaddingSeconds,
    postPad: g.detection?.postPaddingSeconds ?? config.detection.postPaddingSeconds,
    minCut: g.detection?.minSegmentSeconds ?? config.detection.minSegmentSeconds,
    maxCut: g.detection?.maxSegmentSeconds ?? config.detection.maxSegmentSeconds,
    markerTone: g.audio?.jingle?.enabled ?? config.audio.jingle.enabled,
    reuseTranscript: true,
  };

  const perPodcast = Object.entries(overrides.podcasts ?? {}).map(([slug, tuning]) => {
    const meta = seededMeta(config, slug);
    return {
      slug,
      title: config.podcasts[slug]?.name ?? slug,
      color: colorFor(config, slug),
      confidence: tuning.processing?.confidenceThreshold ?? global.confidence,
      prePad: tuning.detection?.prePaddingSeconds ?? global.prePad,
      postPad: tuning.detection?.postPaddingSeconds ?? global.postPad,
      markerTone: tuning.audio?.jingle?.enabled ?? global.markerTone,
      notes: meta.demo?.overrideNote ?? "",
    };
  });

  return {
    global,
    perPodcast,
    defaultsCount: Math.max(0, Object.keys(config.podcasts).length - perPodcast.length),
    adminConfigured: Boolean(config.admin.token || process.env.PODCAST_PROXY_ADMIN_TOKEN),
  };
}

const METHOD_LABELS: Record<string, string> = {
  "forced-word": "whisper+gpt boundary",
  "feed-transcript-segment": "transcript+silence",
  "model-timestamp": "gpt review",
  "stt-chunk": "stt chunk",
  manual: "manual",
};

function formatPubAt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export async function buildEpisodeView(config: AppConfig, slug: string, episodeKey: string): Promise<EpisodeView | undefined> {
  const manifest = await readManifest(config, slug, episodeKey);
  if (!manifest) return undefined;
  const effective = resolvePodcastConfig(config, slug);
  const confidence = effective.processing.confidenceThreshold;
  const transcript = await readJson<Transcript>(episodePaths(config, slug, episodeKey).transcriptJson);
  const transcriptDuration = transcript?.segments.at(-1)?.end;
  const durSource = Math.max(manifest.audio.sourceDurationSeconds ?? 0, manifest.originalDurationSeconds ?? 0, transcriptDuration ?? 0);
  const persistedCuts = manifest.audio.renderedCuts ?? manifest.renderedCuts;
  const removed: Segment[] = persistedCuts
    ? normalizeSegments(persistedCuts, { durationSeconds: durSource })
    : normalizeSegments(removalSegments(manifest.decisions, confidence), {
        durationSeconds: durSource,
        prePaddingSeconds: effective.detection.prePaddingSeconds,
        postPaddingSeconds: effective.detection.postPaddingSeconds,
        minSegmentSeconds: effective.detection.minSegmentSeconds,
        maxSegmentSeconds: effective.detection.maxSegmentSeconds,
      });
  const jingle = manifest.audio.jingleDurationSeconds ?? (manifest.audio.jingleInsertedCount > 0 ? effective.audio.jingle.durationSeconds : 0);
  const durProc = manifest.processedDurationSeconds ?? manifest.audio.durationSeconds ?? durationAfterEdits(durSource, removed, jingle) ?? 0;

  const decisions = manifest.decisions.map((d, index) => ({
    i: index + 1,
    src0: seconds3(d.start),
    src1: seconds3(d.end),
    proc: seconds3(mapOriginalToProcessed(d.start, removed, jingle)),
    dur: Math.round(d.end - d.start),
    action: d.action === "remove" ? ("remove" as const) : ("mark" as const),
    conf: d.confidence,
    who: d.advertiser ?? "—",
    reason: d.reason,
    method: METHOD_LABELS[d.alignment?.method ?? "manual"] ?? "model",
    source: d.source,
    text: d.text,
    alignment: d.alignment,
  }));

  const transcriptRows = (transcript?.segments ?? []).map((segment) => {
    const removedOverlap = removed.some((r) => segment.start < r.end && segment.end > r.start);
    const markOverlap = manifest.decisions.some((d) => d.action === "mark-only" && segment.start < d.end && segment.end > d.start);
    const status: "kept" | "removed" | "partial" = removedOverlap ? "removed" : markOverlap ? "partial" : "kept";
    return {
      src: seconds3(segment.start),
      srcEnd: seconds3(segment.end),
      proc: status === "removed" ? null : seconds3(mapOriginalToProcessed(segment.start, removed, jingle)),
      procEnd: status === "removed" ? null : seconds3(mapOriginalToProcessed(segment.end, removed, jingle)),
      status,
      text: segment.text,
    };
  });

  const numberMatch = /-ep-(\d+)/.exec(manifest.guid ?? "") ?? /(\d+)/.exec(manifest.title);

  return {
    podcast: manifest.podcastName,
    podcastSlug: slug,
    podcastColor: colorFor(config, slug),
    podcastArtworkUrl: await readLocalArtworkUrl(config, slug),
    episodeKey,
    number: numberMatch ? Number(numberMatch[1]) : 0,
    title: manifest.title,
    pubAt: formatPubAt(manifest.pubDate),
    status: manifest.audio.status,
    durSource,
    durProc,
    saved: savedSecondsForManifest(manifest),
    cuts: removeCount(manifest),
    marks: markCount(manifest),
    cost: manifest.costs.actualUsd,
    decisions,
    chaptersSource: (manifest.sourceChapters ?? []).map((c) => ({ t: c.startTime, label: c.title })),
    chaptersFinal: (manifest.chapters ?? []).map((c) => ({ t: c.startTime, label: c.title })),
    transcript: transcriptRows,
    links: {
      manifest: `/assets/${slug}/${episodeKey}/manifest.json`,
      transcriptJson: `/assets/${slug}/${episodeKey}/transcript.json`,
      transcriptVtt: `/assets/${slug}/${episodeKey}/transcript.vtt`,
      chaptersJson: `/assets/${slug}/${episodeKey}/chapters.json`,
      sourceAudio: `/audio/${slug}/${episodeKey}/source.mp3`,
      processedAudio: `/audio/${slug}/${episodeKey}/episode.mp3`,
    },
  };
}
