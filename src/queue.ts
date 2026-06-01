import path from "node:path";
import type { AppConfig, EffectivePodcastConfig, ParsedEpisode, ProcessingOptions } from "./types.js";
import { readJson, writeJson } from "./utils.js";

export type QueueEpisodeState = "queued" | "running" | "completed" | "failed" | "skipped" | "quarantined" | "waiting-for-credits";

export interface QueueAttempt {
  at: string;
  state: QueueEpisodeState;
  stage: string;
  error?: string;
  provider?: string;
  model?: string;
}

export interface QueueEpisode {
  id: string;
  podcastSlug: string;
  episodeKey: string;
  episodeTitle: string;
  pubDate?: string;
  sourceFingerprint?: string;
  state: QueueEpisodeState;
  attempts: number;
  maxAttempts: number;
  currentStage: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  updatedAt: string;
  createdAt: string;
  history: QueueAttempt[];
  requested?: ProcessingOptions;
}

export interface QueueState {
  schemaVersion: 1;
  updatedAt: string;
  episodes: Record<string, QueueEpisode>;
  manualRequests?: ManualReprocessRequest[];
}

export interface RunGuard {
  providerBlocked: boolean;
  providerBlockReason?: string;
}

export type ManualReprocessScope = "episode" | "podcast" | "global" | "failed";

export interface ManualReprocessOptions {
  force?: boolean;
  dryRun?: boolean;
  downloadAudio?: boolean;
  skipArtwork?: boolean;
  reuseTranscript?: boolean;
  fullReprocess?: boolean;
  lookbackDays?: number;
  maxEpisodes?: number;
}

export interface ManualReprocessRequest {
  id: string;
  createdAt: string;
  claimedAt?: string;
  status: "queued" | "claimed" | "completed";
  scope: ManualReprocessScope;
  podcastSlug?: string;
  episodeKey?: string;
  options: ManualReprocessOptions;
}

export interface ManualRunPlan {
  requests: ManualReprocessRequest[];
  episodeKeysByPodcast: Map<string, Set<string>>;
  failedOnly: boolean;
  optionsFor(podcastSlug: string, episodeKey: string): Partial<ProcessingOptions>;
  lookbackDaysFor(podcastSlug: string, fallback: number): number;
  maxEpisodesFor(podcastSlug: string, fallback: number): number;
}

export function queueEpisodeId(podcastSlug: string, episodeKey: string): string {
  return `${podcastSlug}:${episodeKey}`;
}

export async function readQueue(config: AppConfig): Promise<QueueState> {
  return normalizeQueueState(
    (await readJson<QueueState>(queuePath(config))) ?? {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      episodes: {},
      manualRequests: []
    }
  );
}

export async function enqueueManualReprocess(
  config: AppConfig,
  request: Omit<ManualReprocessRequest, "id" | "createdAt" | "status">
): Promise<ManualReprocessRequest> {
  const state = await readQueue(config);
  const createdAt = new Date().toISOString();
  const entry: ManualReprocessRequest = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt,
    status: "queued",
    ...request
  };
  state.manualRequests = [...(state.manualRequests ?? []), entry].slice(-100);
  await writeQueue(config, state);
  return entry;
}

export async function claimManualReprocessRequests(config: AppConfig, slugs: string[]): Promise<ManualRunPlan> {
  const state = await readQueue(config);
  const slugSet = new Set(slugs);
  const now = new Date().toISOString();
  const claimed: ManualReprocessRequest[] = [];
  state.manualRequests = (state.manualRequests ?? []).map((request) => {
    if (request.status !== "queued") return request;
    if (request.podcastSlug && !slugSet.has(request.podcastSlug)) return request;
    const next = { ...request, status: "claimed" as const, claimedAt: now };
    claimed.push(next);
    return next;
  });
  await writeQueue(config, state);
  return buildManualRunPlan(claimed);
}

export async function completeManualReprocessRequests(config: AppConfig, requestIds: string[]): Promise<void> {
  if (requestIds.length === 0) return;
  const ids = new Set(requestIds);
  const state = await readQueue(config);
  state.manualRequests = (state.manualRequests ?? []).map((request) => (ids.has(request.id) ? { ...request, status: "completed" as const } : request));
  await writeQueue(config, state);
}

export async function listQueueEpisodes(config: AppConfig): Promise<QueueEpisode[]> {
  const state = await readQueue(config);
  return Object.values(state.episodes).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function syncDiscoveredEpisode(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode): Promise<QueueEpisode> {
  const state = await readQueue(config);
  const now = new Date().toISOString();
  const id = queueEpisodeId(podcast.slug, episode.key);
  const existing = state.episodes[id];
  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  const retryEligible = existing?.nextRetryAt ? Date.parse(existing.nextRetryAt) <= Date.now() : false;
  const stateForExisting =
    existing && ["completed", "running", "quarantined"].includes(existing.state)
      ? existing.state
      : (existing?.state === "failed" || existing?.state === "waiting-for-credits") && !retryEligible
        ? existing.state
        : "queued";

  const entry: QueueEpisode = {
    id,
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    pubDate: episode.pubDate?.toISOString(),
    sourceFingerprint: episode.sourceFingerprint,
    state: stateForExisting as QueueEpisodeState,
    attempts: existing?.attempts ?? 0,
    maxAttempts,
    currentStage: existing?.currentStage ?? "discovered",
    lastAttemptAt: existing?.lastAttemptAt,
    nextRetryAt: existing?.nextRetryAt,
    lastError: existing?.lastError,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    history: existing?.history ?? [],
    requested: existing?.requested
  };
  state.episodes[id] = entry;
  await writeQueue(config, state);
  return entry;
}

export async function shouldProcessQueueEpisode(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, options: ProcessingOptions, guard: RunGuard): Promise<{ process: boolean; reason?: string }> {
  const entry = await syncDiscoveredEpisode(config, podcast, episode);
  const force = options.force === true || options.fullReprocess === true || podcast.processing.force;
  if (options.episodeKey && options.episodeKey !== episode.key) return { process: false, reason: "different requested episode" };
  if (guard.providerBlocked && needsModelProvider(podcast)) {
    await markQueueWaitingForCredits(config, podcast, episode, guard.providerBlockReason ?? "provider blocked earlier in this run");
    return { process: false, reason: "waiting for credits" };
  }
  if (!force && entry.state === "quarantined") return { process: false, reason: "quarantined" };
  if (!force && entry.state === "waiting-for-credits" && isFatalProviderError(entry.lastError ?? "")) return { process: false, reason: "waiting for credits" };
  if (!force && (entry.state === "failed" || entry.state === "waiting-for-credits") && entry.nextRetryAt && Date.parse(entry.nextRetryAt) > Date.now()) {
    return { process: false, reason: `retry after ${entry.nextRetryAt}` };
  }
  if (!force && entry.attempts >= Math.max(1, config.retry.maxAttempts)) {
    await markQueueQuarantined(config, podcast, episode, "max attempts reached");
    return { process: false, reason: "max attempts reached" };
  }
  return { process: true };
}

export async function markQueueRunning(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, stage: string): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    state: "running",
    attempts: entry.attempts + 1,
    currentStage: stage,
    lastAttemptAt: now,
    nextRetryAt: undefined,
    lastError: undefined,
    updatedAt: now,
    history: appendHistory(entry, { at: now, state: "running", stage })
  }));
}

export async function markQueueStage(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, stage: string): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    currentStage: stage,
    updatedAt: now
  }));
}

export async function markQueueCompleted(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, stage = "completed"): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    state: "completed",
    currentStage: stage,
    nextRetryAt: undefined,
    lastError: undefined,
    updatedAt: now,
    history: appendHistory(entry, { at: now, state: "completed", stage })
  }));
}

export async function markQueueSkipped(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, reason: string): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    state: "skipped",
    currentStage: "skipped",
    lastError: reason,
    updatedAt: now,
    history: appendHistory(entry, { at: now, state: "skipped", stage: "skipped", error: reason })
  }));
}

export async function markQueueFailure(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, error: unknown): Promise<QueueEpisodeState> {
  const errorText = String(error);
  const fatalProvider = isFatalProviderError(errorText);
  const provider = providerForError(errorText);
  let nextState: QueueEpisodeState = fatalProvider ? "waiting-for-credits" : "failed";
  await updateQueueEpisode(config, podcast, episode, (entry, now) => {
    if (!fatalProvider && entry.attempts >= Math.max(1, config.retry.maxAttempts)) nextState = "quarantined";
    const nextRetryAt =
      nextState === "failed"
        ? new Date(Date.now() + Math.max(1, config.retry.retryDelayMinutes) * 60_000).toISOString()
        : undefined;
    return {
      ...entry,
      state: nextState,
      currentStage: nextState === "quarantined" ? "quarantined" : nextState === "waiting-for-credits" ? "waiting-for-credits" : "failed",
      lastError: errorText,
      nextRetryAt,
      updatedAt: now,
      history: appendHistory(entry, {
        at: now,
        state: nextState,
        stage: entry.currentStage || "failed",
        error: errorText,
        provider: fatalProvider ? provider : undefined
      })
    };
  });
  return nextState;
}

export async function markQueueWaitingForCredits(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, reason: string): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    state: "waiting-for-credits",
    currentStage: "waiting-for-credits",
    lastError: reason,
    nextRetryAt: undefined,
    updatedAt: now,
    history: appendHistory(entry, { at: now, state: "waiting-for-credits", stage: "waiting-for-credits", error: reason, provider: providerForError(reason) })
  }));
}

export async function markQueueQuarantined(config: AppConfig, podcast: EffectivePodcastConfig, episode: ParsedEpisode, reason: string): Promise<void> {
  await updateQueueEpisode(config, podcast, episode, (entry, now) => ({
    ...entry,
    state: "quarantined",
    currentStage: "quarantined",
    lastError: reason,
    nextRetryAt: undefined,
    updatedAt: now,
    history: appendHistory(entry, { at: now, state: "quarantined", stage: "quarantined", error: reason })
  }));
}

export async function resetQueueAttempts(config: AppConfig, filter: { podcastSlug?: string; episodeKey?: string; allQuarantined?: boolean }): Promise<number> {
  const state = await readQueue(config);
  const now = new Date().toISOString();
  let count = 0;
  for (const entry of Object.values(state.episodes)) {
    if (filter.podcastSlug && entry.podcastSlug !== filter.podcastSlug) continue;
    if (filter.episodeKey && entry.episodeKey !== filter.episodeKey) continue;
    if (filter.allQuarantined && entry.state !== "quarantined" && entry.state !== "failed" && entry.state !== "waiting-for-credits") continue;
    entry.attempts = 0;
    entry.state = "queued";
    entry.currentStage = "reset";
    entry.lastError = undefined;
    entry.nextRetryAt = undefined;
    entry.updatedAt = now;
    entry.history = appendHistory(entry, { at: now, state: "queued", stage: "reset" });
    count += 1;
  }
  await writeQueue(config, state);
  return count;
}

export function buildManualRunPlan(requests: ManualReprocessRequest[]): ManualRunPlan {
  const episodeKeysByPodcast = new Map<string, Set<string>>();
  const globalRequests = requests.filter((request) => request.scope === "global" || request.scope === "failed");
  const failedOnly = requests.some((request) => request.scope === "failed");

  for (const request of requests) {
    if (request.scope !== "episode" || !request.podcastSlug || !request.episodeKey) continue;
    const set = episodeKeysByPodcast.get(request.podcastSlug) ?? new Set<string>();
    set.add(request.episodeKey);
    episodeKeysByPodcast.set(request.podcastSlug, set);
  }

  return {
    requests,
    episodeKeysByPodcast,
    failedOnly,
    optionsFor(podcastSlug, episodeKey) {
      const matching = requests.filter((request) => {
        if (request.scope === "global" || request.scope === "failed") return true;
        if (request.podcastSlug !== podcastSlug) return false;
        if (request.scope === "podcast") return true;
        return request.scope === "episode" && request.episodeKey === episodeKey;
      });
      return mergeRequestOptions(matching.map((request) => request.options));
    },
    lookbackDaysFor(podcastSlug, fallback) {
      const values = [...globalRequests, ...requests.filter((request) => request.podcastSlug === podcastSlug)]
        .map((request) => request.options.lookbackDays)
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
      return values.length ? Math.max(...values) : fallback;
    },
    maxEpisodesFor(podcastSlug, fallback) {
      const values = [...globalRequests, ...requests.filter((request) => request.podcastSlug === podcastSlug)]
        .map((request) => request.options.maxEpisodes)
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
      return values.length ? Math.max(...values) : fallback;
    }
  };
}

export function queueEntriesForManualRetry(entries: QueueEpisode[], podcastSlug: string): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.podcastSlug === podcastSlug)
      .filter((entry) => entry.state === "failed" || entry.state === "quarantined" || entry.state === "waiting-for-credits")
      .map((entry) => entry.episodeKey)
  );
}

export function isFatalProviderError(errorText: string): boolean {
  return (
    /\b(401|402|403)\b/.test(errorText) ||
    /insufficient credits|requires more credits|credits remaining|quota_exceeded|exceeds your quota|quota exceeded|unauthorized|forbidden|payment required/i.test(errorText)
  );
}

function providerForError(errorText: string): string {
  if (/elevenlabs/i.test(errorText)) return "elevenlabs";
  if (/openrouter/i.test(errorText)) return "openrouter";
  if (/opencode/i.test(errorText)) return "opencode";
  if (/openai/i.test(errorText)) return "openai";
  return "provider";
}

function needsModelProvider(podcast: EffectivePodcastConfig): boolean {
  return podcast.llm.enabled || podcast.transcripts.providers.openRouter.enabled || podcast.transcripts.providers.openai.enabled;
}

async function updateQueueEpisode(
  config: AppConfig,
  podcast: EffectivePodcastConfig,
  episode: ParsedEpisode,
  update: (entry: QueueEpisode, now: string) => QueueEpisode
): Promise<QueueEpisode> {
  const state = await readQueue(config);
  const now = new Date().toISOString();
  const id = queueEpisodeId(podcast.slug, episode.key);
  const existing = state.episodes[id] ?? {
    id,
    podcastSlug: podcast.slug,
    episodeKey: episode.key,
    episodeTitle: episode.title,
    pubDate: episode.pubDate?.toISOString(),
    sourceFingerprint: episode.sourceFingerprint,
    state: "queued" as QueueEpisodeState,
    attempts: 0,
    maxAttempts: Math.max(1, config.retry.maxAttempts),
    currentStage: "discovered",
    updatedAt: now,
    createdAt: now,
    history: []
  };
  const next = update(
    {
      ...existing,
      episodeTitle: episode.title,
      pubDate: episode.pubDate?.toISOString(),
      sourceFingerprint: episode.sourceFingerprint,
      maxAttempts: Math.max(1, config.retry.maxAttempts)
    },
    now
  );
  state.episodes[id] = next;
  await writeQueue(config, state);
  return next;
}

function appendHistory(entry: QueueEpisode, attempt: QueueAttempt): QueueAttempt[] {
  return [...entry.history, attempt].slice(-30);
}

function mergeRequestOptions(options: ManualReprocessOptions[]): Partial<ProcessingOptions> {
  return options.reduce<Partial<ProcessingOptions>>(
    (merged, option) => ({
      ...merged,
      force: merged.force || option.force || option.fullReprocess,
      dryRun: option.dryRun ?? merged.dryRun,
      downloadAudio: option.downloadAudio ?? merged.downloadAudio,
      maxEpisodes: option.maxEpisodes ?? merged.maxEpisodes,
      skipArtwork: option.skipArtwork ?? merged.skipArtwork,
      reuseTranscript: option.reuseTranscript ?? merged.reuseTranscript,
      fullReprocess: merged.fullReprocess || option.fullReprocess
    }),
    {}
  );
}

async function writeQueue(config: AppConfig, state: QueueState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(queuePath(config), state);
}

function queuePath(config: AppConfig): string {
  return path.join(config.storage.dataDir, "queue", "state.json");
}

function normalizeQueueState(state: QueueState): QueueState {
  for (const entry of Object.values(state.episodes)) {
    if (entry.state !== "quarantined") continue;
    if (!isFatalProviderError(entry.lastError ?? "")) continue;
    entry.state = "waiting-for-credits";
    entry.currentStage = "waiting-for-credits";
    entry.nextRetryAt = undefined;
  }
  return state;
}
