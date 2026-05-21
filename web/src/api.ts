// Typed client for the Podcastoor view-model API.

export type PodcastStatus = "ok" | "warn" | "fail" | "run";

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
  automation: { running: boolean; lastStartedAt?: string; lastFinishedAt?: string; lastError?: string };
}

export type QueueState = "queued" | "running" | "completed" | "failed" | "skipped" | "quarantined" | "waiting-for-credits";

export interface QueueRow {
  id: string;
  podcastSlug: string;
  podcastTitle: string;
  podcastColor: string;
  episodeTitle: string;
  state: QueueState;
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

export interface DeepDiveEpisode {
  episodeKey: string;
  title: string;
  guid?: string;
  pubDate?: string;
  originalDurationSeconds?: number;
  processedDurationSeconds?: number;
  decisions: Array<{ action: string; confidence: number }>;
  audio: { status: string; removedSeconds: number };
  costs: { actualUsd: number };
  modelNotes?: string[];
}

export interface DeepDive {
  slug: string;
  name: string;
  host?: string;
  accentColor?: string;
  feedUrl: string;
  subscriptionUrl: string;
  alternateSubscriptionUrl: string;
  demo?: {
    episodes?: number;
    processed?: number;
    failed?: number;
    quarantined?: number;
    savedSeconds?: number;
    avgAdsPct?: number;
    spend30dUsd?: number;
    latestRelative?: string;
  };
  metadata: {
    feedTitle?: string;
    description?: string;
    sourceImageUrl?: string;
    localArtworkUrl?: string;
    feedError?: string;
    manifestCount: number;
    processedCount: number;
    transcriptionModel: string;
    classifierModel: string;
  };
  config: {
    processing: { confidenceThreshold: number };
    effectiveProcessing: { confidenceThreshold: number };
    detection: { prePaddingSeconds: number; postPaddingSeconds: number; minSegmentSeconds: number; maxSegmentSeconds: number };
    audio: { jingle: { enabled: boolean } };
    transcripts: unknown;
    llm: { enabled: boolean; model: string };
  };
  episodes: DeepDiveEpisode[];
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

const ADMIN_TOKEN_KEY = "podcastoor.adminToken";

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
}

export function setAdminToken(token: string): void {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function ensureAdminToken(): string | undefined {
  let token = getAdminToken();
  if (!token) {
    token = window.prompt("Admin token required for this action") ?? "";
    if (token) setAdminToken(token);
  }
  return token || undefined;
}

export async function runAdminAction(action: () => Promise<unknown>, onDone?: () => void): Promise<void> {
  if (!ensureAdminToken()) return;
  try {
    await action();
    onDone?.();
  } catch (err) {
    window.alert(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": getAdminToken() },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  return data;
}

export const api = {
  dashboard: () => getJson<DashboardView>("/api/dashboard"),
  deepDive: (slug: string) => getJson<DeepDive>(`/api/podcasts/${slug}`),
  episode: (slug: string, key: string) => getJson<EpisodeView>(`/api/podcasts/${slug}/episodes/${key}`),
  queue: () => getJson<{ queue: QueueRow[]; automation: DashboardView["automation"] }>("/api/queue-view"),
  cost: () => getJson<CostView>("/api/cost-view"),
  tuning: () => getJson<TuningView>("/api/tuning"),
  addFeed: (body: { name: string; feedUrl: string }) => postJson<{ ok: boolean; slug: string }>("/api/actions/add-feed", body),
  reprocess: (body: Record<string, unknown>) => postJson<{ ok: boolean }>("/api/actions/reprocess", body),
  resetAttempts: (body: Record<string, unknown>) => postJson<{ ok: boolean }>("/api/actions/reset-attempts", body),
  saveTuning: (body: Record<string, unknown>) => postJson<{ ok: boolean }>("/api/runtime-overrides/tuning", body),
};
