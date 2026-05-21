import path from "node:path";
import YAML from "yaml";
import { writeFile } from "node:fs/promises";
import type { AppConfig, Chapter, EpisodeManifest, SegmentDecision, Transcript, TranscriptSegment } from "./types.js";
import { episodeKey as makeEpisodeKey, ensureDir, formatTimestamp, writeJson } from "./utils.js";
import { episodePaths, writeManifest } from "./storage.js";
import type { QueueEpisode, QueueEpisodeState, QueueState } from "./queue.js";
import { queueEpisodeId } from "./queue.js";
import type { ActivityEvent } from "./activity.js";
import type { RuntimeOverrides } from "./runtime-overrides.js";

const PIPELINE_VERSION = "demo-seed";

interface SeedPodcast {
  slug: string;
  name: string;
  host: string;
  color: string;
  description: string;
  feedUrl: string;
  stats: {
    episodes: number;
    processed: number;
    failed: number;
    quarantined: number;
    savedSeconds: number;
    avgAdsPct: number;
    spend30dUsd: number;
    latestRelative: string;
    status: "ok" | "warn" | "fail" | "run";
  };
}

const PODCASTS: SeedPodcast[] = [
  { slug: "latent-space", name: "Latent Space", host: "Swyx & Alessio", color: "#e8743a",
    description: "Long-form interviews and field notes from people building speech, language, and agent systems. Lightly produced, occasionally live from conferences. Hosts read their own sponsors, which is exactly why this feed gets the lowest confidence threshold of the eight.",
    feedUrl: "https://feeds.example.com/latent-space.xml",
    stats: { episodes: 142, processed: 138, failed: 2, quarantined: 1, savedSeconds: 51720, avgAdsPct: 7.2, spend30dUsd: 62.4, latestRelative: "2d ago", status: "ok" } },
  { slug: "margin-calls", name: "Margin Calls", host: "Marta Voss", color: "#9c6dd8",
    description: "Daily markets explainer. What the Fed said, what it meant, and what to ignore. Tightly produced; the host never reads ads mid-segment.",
    feedUrl: "https://feeds.example.com/margin-calls.xml",
    stats: { episodes: 89, processed: 89, failed: 0, quarantined: 0, savedSeconds: 32640, avgAdsPct: 5.1, spend30dUsd: 18.4, latestRelative: "4h ago", status: "ok" } },
  { slug: "foglines", name: "Foglines", host: "Independent Public", color: "#6b9bb8",
    description: "Reported audio essays from the edges of a coastal city. Public-radio cadence with dynamic ad insertion that drifts week to week.",
    feedUrl: "https://feeds.example.com/foglines.xml",
    stats: { episodes: 56, processed: 54, failed: 1, quarantined: 0, savedSeconds: 22260, avgAdsPct: 8.3, spend30dUsd: 42.18, latestRelative: "1d ago", status: "warn" } },
  { slug: "cold-open", name: "Cold Open", host: "Mira & Jules", color: "#d8a23f",
    description: "Two editors re-cut famous films scene by scene. Conversational, sponsor reads bookended at the top and tail.",
    feedUrl: "https://feeds.example.com/cold-open.xml",
    stats: { episodes: 73, processed: 73, failed: 0, quarantined: 0, savedSeconds: 31620, avgAdsPct: 6.4, spend30dUsd: 28.71, latestRelative: "6h ago", status: "ok" } },
  { slug: "off-mic", name: "Off-Mic w/ Reza", host: "Reza Sayadi", color: "#e85a47",
    description: "Founder interviews recorded in one take. Loose structure means ad reads land in unpredictable places — the hardest feed to cut cleanly.",
    feedUrl: "https://feeds.example.com/off-mic.xml",
    stats: { episodes: 31, processed: 28, failed: 3, quarantined: 1, savedSeconds: 11940, avgAdsPct: 9.1, spend30dUsd: 14.82, latestRelative: "5h ago", status: "fail" } },
  { slug: "throughline-daily", name: "Throughline Daily", host: "Drift Media", color: "#5ab886",
    description: "The day in three minutes, every weekday. Short, heavily templated, dynamic mid-rolls — tight padding and a high confidence threshold work best here.",
    feedUrl: "https://feeds.example.com/throughline-daily.xml",
    stats: { episodes: 412, processed: 412, failed: 0, quarantined: 0, savedSeconds: 139800, avgAdsPct: 11.2, spend30dUsd: 84.2, latestRelative: "1h ago", status: "run" } },
  { slug: "open-verdict", name: "Open Verdict", host: "KCRX Legal", color: "#8492a8",
    description: "A working courthouse reporter walks one case per episode. Slow, deliberate delivery; widen the padding so judges' pauses are not clipped.",
    feedUrl: "https://feeds.example.com/open-verdict.xml",
    stats: { episodes: 64, processed: 64, failed: 0, quarantined: 0, savedSeconds: 26880, avgAdsPct: 6.0, spend30dUsd: 31.05, latestRelative: "12h ago", status: "ok" } },
  { slug: "sample-rate", name: "The Sample Rate", host: "Jonas Dahl", color: "#c66b4e",
    description: "Field-recording and audio-gear deep dives. Niche, irregular schedule, and a back catalogue that frequently trips the decoder.",
    feedUrl: "https://feeds.example.com/sample-rate.xml",
    stats: { episodes: 22, processed: 18, failed: 4, quarantined: 2, savedSeconds: 7320, avgAdsPct: 4.4, spend30dUsd: 5.74, latestRelative: "3d ago", status: "fail" } },
];

interface SeedEpisode {
  n: number;
  title: string;
  whenDaysAgo: number;
  status: "completed" | "failed" | "skipped" | "quarantined" | "dry-run";
  src: number;
  proc: number;
  cuts: number;
  marks: number;
  cost: number;
  err?: string;
  note?: string;
}

const LATENT_EPISODES: SeedEpisode[] = [
  { n: 142, title: "Scaling speech models past 100B params, with Annika Werner", whenDaysAgo: 2, status: "completed", src: 4823, proc: 4271, cuts: 6, marks: 2, cost: 1.84 },
  { n: 141, title: "The mixture-of-experts revival", whenDaysAgo: 5, status: "completed", src: 3712, proc: 3340, cuts: 5, marks: 1, cost: 1.52 },
  { n: 140, title: "Annika Werner on Aalto and the Finns", whenDaysAgo: 8, status: "completed", src: 5104, proc: 4520, cuts: 7, marks: 3, cost: 2.1 },
  { n: 139, title: "Why retrieval ate everyone’s budget", whenDaysAgo: 11, status: "completed", src: 4180, proc: 3640, cuts: 6, marks: 2, cost: 1.71 },
  { n: 138, title: "A field guide to speculative decoding", whenDaysAgo: 14, status: "completed", src: 3902, proc: 3450, cuts: 5, marks: 1, cost: 1.62 },
  { n: 137, title: "Live from NeurIPS — day three", whenDaysAgo: 17, status: "failed", src: 6210, proc: 0, cuts: 0, marks: 0, cost: 0.42, err: "whisper decode failed at 00:34:12 (3 attempts)" },
  { n: 136, title: "Tokenizer drift is the new tech debt", whenDaysAgo: 21, status: "completed", src: 3408, proc: 3010, cuts: 4, marks: 2, cost: 1.38 },
  { n: 135, title: "Voice cloning, ethics, and TOS-creep", whenDaysAgo: 24, status: "skipped", src: 2810, proc: 0, cuts: 0, marks: 0, cost: 0, note: "manual skip by admin" },
  { n: 134, title: "Building agents that wait", whenDaysAgo: 28, status: "quarantined", src: 4912, proc: 0, cuts: 0, marks: 0, cost: 0.18, err: "detection timeout 5/5" },
  { n: 133, title: "Inference cost in the year of the GPU", whenDaysAgo: 31, status: "completed", src: 4188, proc: 3700, cuts: 6, marks: 2, cost: 1.74 },
];

// Full-fidelity decisions for Latent Space ep 142 (the deep-dive hero).
const EP142_DECISIONS: SegmentDecision[] = [
  { start: 142, end: 201, action: "remove", confidence: 0.97, advertiser: "Squarespace", reason: "host-read pre-roll", source: "model", alignment: { method: "forced-word" } },
  { start: 1248, end: 1289, action: "remove", confidence: 0.94, advertiser: "BetterHelp", reason: "sponsor segue ‘speaking of’", source: "model", alignment: { method: "feed-transcript-segment" } },
  { start: 1922, end: 1947, action: "mark-only", confidence: 0.62, reason: "self-promo — own newsletter", source: "model", alignment: { method: "model-timestamp" } },
  { start: 2611, end: 2733, action: "remove", confidence: 0.99, advertiser: "Vanta", reason: "mid-roll w/ ad-stinger", source: "model", alignment: { method: "forced-word" } },
  { start: 3104, end: 3132, action: "mark-only", confidence: 0.58, reason: "“if you’re enjoying…”", source: "model", alignment: { method: "model-timestamp" } },
  { start: 3812, end: 3961, action: "remove", confidence: 0.96, advertiser: "AssemblyAI", reason: "post-roll", source: "model", alignment: { method: "feed-transcript-segment" } },
  { start: 4421, end: 4519, action: "remove", confidence: 0.93, advertiser: "BetterHelp", reason: "second BetterHelp read", source: "model", alignment: { method: "feed-transcript-segment" } },
  { start: 4720, end: 4823, action: "remove", confidence: 0.91, advertiser: "House (newsletter)", reason: "outro CTA", source: "model", alignment: { method: "feed-transcript-segment" } },
];

const EP142_SOURCE_CHAPTERS: Chapter[] = [
  { startTime: 0, title: "Cold open" },
  { startTime: 142, title: "Sponsor: Squarespace" },
  { startTime: 201, title: "Welcome and intros" },
  { startTime: 612, title: "Annika on the early Aalto years" },
  { startTime: 1248, title: "Sponsor: BetterHelp" },
  { startTime: 1289, title: "Why bigger models stalled in ’24" },
  { startTime: 2611, title: "Sponsor: Vanta" },
  { startTime: 2733, title: "The 100B-param speech model" },
  { startTime: 3812, title: "Sponsor: AssemblyAI" },
  { startTime: 3961, title: "Hardware constraints in practice" },
  { startTime: 4421, title: "Sponsor: BetterHelp (2nd)" },
  { startTime: 4519, title: "Closing thoughts and predictions" },
  { startTime: 4720, title: "Sponsor: House newsletter" },
];

const EP142_FINAL_CHAPTERS: Chapter[] = [
  { startTime: 0, title: "Cold open" },
  { startTime: 142, title: "Welcome and intros" },
  { startTime: 553, title: "The early Aalto years" },
  { startTime: 1130, title: "Why bigger models stalled in ’24" },
  { startTime: 2400, title: "The 100B-param speech model" },
  { startTime: 3301, title: "Hardware constraints in practice" },
  { startTime: 3611, title: "Closing thoughts and predictions" },
];

const EP142_TRANSCRIPT: Array<{ start: number; text: string }> = [
  { start: 0, text: "Welcome back. This week, big audio." },
  { start: 18, text: "Before we get to it —" },
  { start: 142, text: "This episode is brought to you by Squarespace. Your website should’ve been live yesterday —" },
  { start: 201, text: "OK, on with it. Annika Werner builds speech models. The big ones." },
  { start: 240, text: "Annika, welcome back." },
  { start: 1248, text: "Speaking of building, this episode is also brought to you by BetterHelp." },
  { start: 1289, text: "So there’s this stall in 2024 where everyone collectively realized scale alone —" },
  { start: 1922, text: "If you’re enjoying this, the newsletter goes deeper every Thursday — but back to it," },
  { start: 1947, text: "the architecture changes were what mattered, not the parameters." },
  { start: 2611, text: "♪ Vanta makes SOC 2 compliance painless —" },
  { start: 2733, text: "You eventually crossed the hundred-billion line. What broke first?" },
];

const QUEUE_ROWS: Array<{
  slug: string; title: string; state: QueueEpisodeState; stage: string; attempts: number;
  lastMinutesAgo?: number; retryInMinutes?: number | "manual"; err?: string; model?: string;
}> = [
  { slug: "throughline-daily", title: "412 · Day in three minutes — Tuesday", state: "running", stage: "splice", attempts: 1, lastMinutesAgo: 0, model: "gpt-4o-mini" },
  { slug: "latent-space", title: "142 · Scaling speech models past 100B params", state: "queued", stage: "discovered", attempts: 0, retryInMinutes: 2 },
  { slug: "foglines", title: "57 · Salt marsh radio diaries", state: "queued", stage: "discovered", attempts: 0, retryInMinutes: 4 },
  { slug: "off-mic", title: "29 · The fall of the Hanseatic export desk", state: "failed", stage: "render", attempts: 3, lastMinutesAgo: 71, retryInMinutes: 49, err: "ffmpeg exit 1: invalid sample format aac" },
  { slug: "sample-rate", title: "22 · Bus-powered preamps, are we kidding", state: "quarantined", stage: "detect", attempts: 5, lastMinutesAgo: 318, retryInMinutes: "manual", err: "detection timeout > 600s (3rd)", model: "gpt-4o-mini" },
  { slug: "off-mic", title: "28 · Recovering tapes from a paper mill", state: "failed", stage: "transcribe", attempts: 2, lastMinutesAgo: 34, retryInMinutes: 26, err: "whisper: audio decode failed at 00:34:12", model: "whisper-large-v3" },
  { slug: "sample-rate", title: "21 · Field recording in -15°C", state: "completed", stage: "completed", attempts: 1, lastMinutesAgo: 112 },
  { slug: "latent-space", title: "141 · The mixture-of-experts revival", state: "completed", stage: "completed", attempts: 1, lastMinutesAgo: 190 },
  { slug: "margin-calls", title: "89 · What the Fed actually said this morning", state: "completed", stage: "completed", attempts: 1, lastMinutesAgo: 268 },
  { slug: "cold-open", title: "73 · Re-cutting Heat with Mann’s storyboards", state: "completed", stage: "completed", attempts: 1, lastMinutesAgo: 294 },
];

const ACTIVITY_ROWS: Array<{ minutesAgo: number; slug: string; ep: string; stage: string; msg: string; level: ActivityEvent["level"]; outcome: "ok" | "info" | "warn" | "fail" }> = [
  { minutesAgo: 0, slug: "throughline-daily", ep: "412", stage: "splice", msg: "rendered 23m41s, 4 cuts", level: "info", outcome: "ok" },
  { minutesAgo: 0, slug: "throughline-daily", ep: "412", stage: "align", msg: "boundary review on 2 partials", level: "info", outcome: "info" },
  { minutesAgo: 2, slug: "latent-space", ep: "142", stage: "queue", msg: "enqueued (manual reprocess)", level: "info", outcome: "info" },
  { minutesAgo: 4, slug: "off-mic", ep: "30", stage: "detect", msg: "low-confidence ad band 41:12-42:08", level: "warn", outcome: "warn" },
  { minutesAgo: 8, slug: "sample-rate", ep: "22", stage: "transcribe", msg: "whisper-large-v3 → 4m13s audio", level: "info", outcome: "info" },
  { minutesAgo: 11, slug: "off-mic", ep: "29", stage: "render", msg: "FAILED: ffmpeg exit 1 (sample fmt)", level: "error", outcome: "fail" },
  { minutesAgo: 13, slug: "cold-open", ep: "73", stage: "chapters", msg: "12 chapters → 8 after merge", level: "info", outcome: "ok" },
  { minutesAgo: 14, slug: "margin-calls", ep: "89", stage: "detect", msg: "no ads found", level: "info", outcome: "ok" },
  { minutesAgo: 17, slug: "foglines", ep: "56", stage: "splice", msg: "rendered 47m12s, 6 cuts", level: "info", outcome: "ok" },
  { minutesAgo: 20, slug: "open-verdict", ep: "64", stage: "publish", msg: "feed regenerated", level: "info", outcome: "ok" },
];

const DAILY_CURVE = [4.1, 6.25, 5.8, 7.4, 9.15, 8.2, 11.0, 9.4, 10.1, 12.7, 11.85, 9.2, 8.4, 10.9, 12.0, 13.4, 11.5, 10.2, 9.8, 11.4, 13.1, 14.6, 12.2, 11.0, 10.3, 12.84];

const COST_MODELS = [
  { stage: "transcript" as const, model: "whisper-large-v3", weight: 0.32 },
  { stage: "ad-detection" as const, model: "gpt-4o-mini", weight: 0.43 },
  { stage: "chapter-generation" as const, model: "gpt-4o", weight: 0.14 },
  { stage: "transcript" as const, model: "AssemblyAI", weight: 0.07 },
  { stage: "alignment" as const, model: "elevenlabs", weight: 0.04 },
];

function isoDaysAgo(days: number, hour = 9): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function buildEpisodeManifest(podcast: SeedPodcast, ep: SeedEpisode): EpisodeManifest {
  const key = makeEpisodeKey(`${podcast.slug}:${ep.n}:${ep.title}`);
  const isHero = podcast.slug === "latent-space" && ep.n === 142;
  const completed = ep.status === "completed";

  const decisions: SegmentDecision[] = isHero
    ? EP142_DECISIONS
    : completed
      ? buildSyntheticDecisions(ep)
      : [];
  const sourceChapters: Chapter[] = isHero ? EP142_SOURCE_CHAPTERS : completed ? buildSyntheticChapters(ep) : [];
  const finalChapters: Chapter[] = isHero
    ? EP142_FINAL_CHAPTERS
    : sourceChapters.filter((c) => !/Sponsor/.test(c.title));

  const removedSeconds = completed ? Math.max(0, ep.src - ep.proc) : 0;
  const audioStatus: EpisodeManifest["audio"]["status"] = ep.status === "dry-run" ? "dry-run" : completed ? "completed" : "skipped";

  return {
    schemaVersion: 1,
    pipelineVersion: PIPELINE_VERSION,
    processingSignature: `${podcast.slug}:${ep.n}:${ep.cuts}c${ep.marks}m`,
    podcastSlug: podcast.slug,
    podcastName: podcast.name,
    episodeKey: key,
    title: ep.title,
    guid: `${podcast.slug}-ep-${ep.n}`,
    sourceUrl: `${podcast.feedUrl.replace(/\.xml$/, "")}/ep-${ep.n}.mp3`,
    sourceFingerprint: `${podcast.slug}-${ep.n}-fp`,
    pubDate: isoDaysAgo(ep.whenDaysAgo, 6),
    originalDurationSeconds: ep.src,
    processedDurationSeconds: completed ? ep.proc : undefined,
    decisions,
    untimedSignals: [],
    modelNotes: ep.note ? [ep.note] : ep.err ? [ep.err] : [],
    sourceChapters,
    chapters: completed ? finalChapters : [],
    transcript: completed
      ? { source: "openRouter", format: "json", path: undefined, segmentCount: isHero ? EP142_TRANSCRIPT.length : 0, model: "whisper-large-v3", seconds: ep.src, costUsd: Number((ep.cost * 0.4).toFixed(4)) }
      : undefined,
    audio: {
      status: audioStatus,
      sourceDurationSeconds: ep.src,
      durationSeconds: completed ? ep.proc : undefined,
      removedSeconds,
      jingleInsertedCount: ep.cuts,
      renderMode: completed ? "encode" : "dry-run",
      codec: "mp3",
      bitrateKbps: 96,
    },
    costs: {
      estimatedUsd: Number((ep.cost * 1.05).toFixed(4)),
      actualUsd: ep.cost,
      llmCalls: ep.cuts + ep.marks,
      notes: ep.err ? [ep.err] : [],
    },
    generatedAt: isoDaysAgo(ep.whenDaysAgo, 7),
  };
}

function buildSyntheticDecisions(ep: SeedEpisode): SegmentDecision[] {
  const advertisers = ["Squarespace", "BetterHelp", "Vanta", "AssemblyAI", "Shopify", "Notion", "Mailchimp"];
  const out: SegmentDecision[] = [];
  const span = ep.src / (ep.cuts + ep.marks + 1);
  let i = 0;
  for (let c = 0; c < ep.cuts; c++) {
    const start = Math.round(span * (i + 1));
    out.push({ start, end: start + 45 + c * 12, action: "remove", confidence: 0.9 + (c % 3) * 0.03, advertiser: advertisers[c % advertisers.length], reason: c === 0 ? "host-read pre-roll" : c === ep.cuts - 1 ? "post-roll" : "mid-roll sponsor read", source: "model", alignment: { method: "feed-transcript-segment" } });
    i++;
  }
  for (let m = 0; m < ep.marks; m++) {
    const start = Math.round(span * (i + 1));
    out.push({ start, end: start + 26, action: "mark-only", confidence: 0.55 + m * 0.04, reason: "self-promo — newsletter", source: "model", alignment: { method: "model-timestamp" } });
    i++;
  }
  return out.sort((a, b) => a.start - b.start);
}

function buildSyntheticChapters(ep: SeedEpisode): Chapter[] {
  const titles = ["Cold open", "Sponsor: Squarespace", "Welcome and intros", "The main thread", "Sponsor: BetterHelp", "Going deeper", "Sponsor: Vanta", "The hard part", "Closing thoughts"];
  const span = ep.src / titles.length;
  return titles.map((title, idx) => ({ startTime: Math.round(span * idx), title }));
}

function buildHeroTranscript(): Transcript {
  const segments: TranscriptSegment[] = EP142_TRANSCRIPT.map((row, idx) => ({
    start: row.start,
    end: idx + 1 < EP142_TRANSCRIPT.length ? EP142_TRANSCRIPT[idx + 1].start : row.start + 30,
    text: row.text,
  }));
  return {
    source: "openRouter",
    format: "json",
    language: "en",
    text: EP142_TRANSCRIPT.map((r) => r.text).join(" "),
    segments,
    usage: { provider: "openrouter", model: "whisper-large-v3", seconds: 4823, costUsd: 0.74 },
  };
}

function buildVtt(transcript: Transcript): string {
  const cues = transcript.segments
    .map((segment, index) => `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${segment.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${cues}\n`;
}

function buildQueueState(): QueueState {
  const episodes: Record<string, QueueEpisode> = {};
  let order = 0;
  for (const row of QUEUE_ROWS) {
    const key = makeEpisodeKey(`${row.slug}:${row.title}`);
    const id = queueEpisodeId(row.slug, key);
    const now = isoMinutesAgo(order);
    const lastAttemptAt = row.lastMinutesAgo != null ? isoMinutesAgo(row.lastMinutesAgo) : undefined;
    const nextRetryAt = typeof row.retryInMinutes === "number" ? isoMinutesAgo(-row.retryInMinutes) : undefined;
    episodes[id] = {
      id,
      podcastSlug: row.slug,
      episodeKey: key,
      episodeTitle: row.title,
      pubDate: isoDaysAgo(1, 6),
      sourceFingerprint: `${row.slug}-q-fp`,
      state: row.state,
      attempts: row.attempts,
      maxAttempts: 5,
      currentStage: row.stage,
      lastAttemptAt,
      nextRetryAt,
      lastError: row.err,
      updatedAt: now,
      createdAt: isoMinutesAgo(row.lastMinutesAgo != null ? row.lastMinutesAgo + 30 : 60),
      history: row.model
        ? [{ at: lastAttemptAt ?? now, state: row.state, stage: row.stage, error: row.err, model: row.model }]
        : [],
    };
    order++;
  }
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), episodes, manualRequests: [] };
}

interface CostRun {
  at: string;
  podcastSlug: string;
  episodeKey: string;
  estimatedUsd: number;
  actualUsd: number;
  llmCalls: number;
  notes: string[];
}

function buildCostLedger() {
  const totalShare = PODCASTS.reduce((sum, p) => sum + p.stats.spend30dUsd, 0);
  const runs: CostRun[] = [];
  let actualUsd = 0;
  let llmCalls = 0;

  DAILY_CURVE.forEach((dayTotal, idx) => {
    const daysAgo = DAILY_CURVE.length - 1 - idx;
    for (const podcast of PODCASTS) {
      const podcastDayUsd = Number(((dayTotal * podcast.stats.spend30dUsd) / totalShare).toFixed(4));
      if (podcastDayUsd < 0.005) continue;
      const notes: string[] = [];
      let attributed = 0;
      for (const model of COST_MODELS) {
        const usd = Number((podcastDayUsd * model.weight).toFixed(4));
        if (usd < 0.0005) continue;
        attributed += usd;
        const units = model.stage === "transcript" ? `${(usd / 0.006).toFixed(1)} min` : model.stage === "alignment" ? `${(usd / 0.01).toFixed(1)} min` : `${Math.round(usd * 800)} tok`;
        notes.push(`${model.stage} actual: ${units} on ${model.model} = $${usd.toFixed(4)}`);
      }
      const runUsd = Number(attributed.toFixed(4));
      runs.push({
        at: isoDaysAgo(daysAgo, 8 + (PODCASTS.indexOf(podcast) % 6)),
        podcastSlug: podcast.slug,
        episodeKey: makeEpisodeKey(`${podcast.slug}:cost:${daysAgo}`),
        estimatedUsd: Number((runUsd * 1.04).toFixed(4)),
        actualUsd: runUsd,
        llmCalls: 2,
        notes,
      });
      actualUsd += runUsd;
      llmCalls += 2;
    }
  });

  return {
    month: new Date().toISOString().slice(0, 7),
    actualUsd: Number(actualUsd.toFixed(4)),
    estimatedUsd: Number((actualUsd * 1.04).toFixed(4)),
    llmCalls,
    runs,
  };
}

function buildActivity(): ActivityEvent[] {
  return ACTIVITY_ROWS.map((row, idx) => ({
    id: `seed-${idx}`,
    at: isoMinutesAgo(row.minutesAgo),
    level: row.level,
    scope: "worker" as const,
    message: row.msg,
    podcastSlug: row.slug,
    episodeKey: `${row.slug}-ep-${row.ep}`,
    episodeTitle: `Ep ${row.ep}`,
    details: { stage: row.stage, outcome: row.outcome, episodeNumber: row.ep },
  }));
}

function buildRuntimeOverrides(): RuntimeOverrides {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    global: {
      processing: { confidenceThreshold: 0.65 },
      detection: { prePaddingSeconds: 0.45, postPaddingSeconds: 0.3, minSegmentSeconds: 8, maxSegmentSeconds: 180 },
      audio: { jingle: { enabled: true } },
    },
    podcasts: {
      "latent-space": { processing: { confidenceThreshold: 0.55 }, detection: { prePaddingSeconds: 0.45, postPaddingSeconds: 0.3 }, audio: { jingle: { enabled: true } } },
      "throughline-daily": { processing: { confidenceThreshold: 0.75 }, detection: { prePaddingSeconds: 0.2, postPaddingSeconds: 0.2 }, audio: { jingle: { enabled: false } } },
      "open-verdict": { processing: { confidenceThreshold: 0.7 }, detection: { prePaddingSeconds: 0.5, postPaddingSeconds: 0.5 }, audio: { jingle: { enabled: true } } },
    },
  };
}

const OVERRIDE_NOTES: Record<string, string> = {
  "latent-space": "host-reads share rhythm with content",
  "throughline-daily": "short episodes; tight padding",
  "open-verdict": "judges talk slow; widen pad",
};

export function buildSeedConfig(dataDir: string): Record<string, unknown> {
  return {
    server: { host: "0.0.0.0", port: 3729, publicBaseUrl: "http://localhost:3729" },
    storage: { dataDir },
    automation: { enabled: false, processOnStartup: false, intervalMinutes: 60 },
    admin: { token: "demo-admin-token" },
    costs: { monthlyBudgetUsd: 450, perRunBudgetUsd: 5, dailyBudgetUsd: 25, transcribeMaxMinutesPerRun: 180, llmMaxInputTokensPerRun: 250000, llmMaxOutputTokensPerRun: 20000 },
    podcasts: Object.fromEntries(
      PODCASTS.map((p) => [
        p.slug,
        {
          name: p.name,
          feedUrl: p.feedUrl,
          host: p.host,
          accentColor: p.color,
          description: p.description,
          demo: { ...p.stats, overrideNote: OVERRIDE_NOTES[p.slug] },
        },
      ])
    ),
  };
}

export interface SeedResult {
  configPath: string;
  dataDir: string;
  podcasts: number;
  episodes: number;
  queueJobs: number;
  costRuns: number;
}

export async function seedDemoData(config: AppConfig): Promise<SeedResult> {
  const dataDir = config.storage.dataDir;
  let episodes = 0;

  for (const podcast of PODCASTS) {
    const list = podcast.slug === "latent-space" ? LATENT_EPISODES : buildGenericEpisodes(podcast);
    for (const ep of list) {
      const manifest = buildEpisodeManifest(podcast, ep);
      await writeManifest(config, manifest);
      episodes++;
      const paths = episodePaths(config, podcast.slug, manifest.episodeKey);
      if (manifest.audio.status === "completed") {
        await writeJson(paths.chaptersJson, { version: "1.2.0", chapters: manifest.chapters.map((c) => ({ startTime: c.startTime, title: c.title })) });
      }
      if (podcast.slug === "latent-space" && ep.n === 142) {
        const transcript = buildHeroTranscript();
        await writeJson(paths.transcriptJson, transcript);
        await writeFile(paths.transcriptVtt, buildVtt(transcript), "utf8");
      }
    }
  }

  const queue = buildQueueState();
  await writeJson(path.join(dataDir, "queue", "state.json"), queue);

  const ledger = buildCostLedger();
  await writeJson(path.join(dataDir, "usage", "costs.json"), ledger);

  await writeJson(path.join(dataDir, "activity", "events.json"), buildActivity().reverse());
  await writeJson(path.join(dataDir, "config", "runtime-overrides.json"), buildRuntimeOverrides());

  return {
    configPath: "",
    dataDir,
    podcasts: PODCASTS.length,
    episodes,
    queueJobs: Object.keys(queue.episodes).length,
    costRuns: ledger.runs.length,
  };
}

function buildGenericEpisodes(podcast: SeedPodcast): SeedEpisode[] {
  const count = Math.min(podcast.stats.episodes, 10);
  const topics: Record<string, string[]> = {
    "margin-calls": ["What the Fed actually said this morning", "The yield curve un-inverts", "Earnings season survival guide", "When the dollar sneezes", "Reading the dot plot", "Credit spreads are talking", "A quiet week, deliberately", "The carry trade unwinds", "Buybacks vs dividends", "Why gold moved"],
    "foglines": ["The houseboat that ate the bay", "Salt marsh radio diaries", "A bridge with no name", "The last cannery shift", "Fog signals and foghorns", "Tide tables and tall tales", "The ferry that never docks", "Letters from the lighthouse", "Reclaimed land, reclaimed stories", "The pier at low water"],
    "cold-open": ["Re-cutting Heat with Mann’s storyboards", "The opening of Jaws, frame by frame", "Why Sicario starts in silence", "Editing the diner scene", "The match cut heard round the world", "Cutting comedy timing", "Trailers that lie", "The 12-minute single take", "Sound design as story", "When to hold a shot"],
    "off-mic": ["Annika Werner on building a printer empire", "The fall of the Hanseatic export desk", "Recovering tapes from a paper mill", "One-take founder confessions", "The pivot nobody saw coming", "Hiring your first ten", "Burning the runway", "The co-founder breakup", "Selling without a sales team", "What the deck never shows"],
    "throughline-daily": ["Day in three minutes — Tuesday", "Day in three minutes — Monday", "Day in three minutes — Friday", "Day in three minutes — Thursday", "Day in three minutes — Wednesday", "Weekend brief", "Markets at the open", "The afternoon read", "What you missed", "Tomorrow, today"],
    "open-verdict": ["The county clerk who refused to file", "A mistrial in three acts", "The witness who changed her story", "Sidebar: what the jury never heard", "The appeal nobody expected", "Discovery, redacted", "The plea before dawn", "When the judge recused", "Exhibit C", "The verdict, read twice"],
    "sample-rate": ["Bus-powered preamps, are we kidding ourselves", "Field recording in -15°C", "The myth of the flat response", "Ribbon mics in the wild", "Cable runs and ground loops", "Sample rates that matter", "Building a quiet room", "The hiss budget", "Portable rigs that survive rain", "Why your interface clips"],
  };
  const list = topics[podcast.slug] ?? Array.from({ length: count }, (_, i) => `Episode ${podcast.stats.episodes - i}`);
  return Array.from({ length: count }, (_, i) => {
    const n = podcast.stats.episodes - i;
    const fail = i === 5 && podcast.stats.failed > 0;
    const quar = i === 7 && podcast.stats.quarantined > 0;
    const src = 2400 + ((n * 137) % 3200);
    const cuts = fail || quar ? 0 : 3 + (n % 5);
    const marks = fail || quar ? 0 : n % 3;
    const proc = fail || quar ? 0 : Math.round(src * (0.86 + (n % 7) * 0.01));
    return {
      n,
      title: list[i % list.length],
      whenDaysAgo: i * 3 + (podcast.slug === "throughline-daily" ? 0 : 1),
      status: fail ? "failed" : quar ? "quarantined" : "completed",
      src,
      proc,
      cuts,
      marks,
      cost: fail || quar ? 0.2 : Number((1.2 + (n % 9) * 0.12).toFixed(2)),
      err: fail ? "whisper decode failed at 00:34:12 (3 attempts)" : quar ? "detection timeout 5/5" : undefined,
    };
  });
}

export async function writeSeedConfigFile(configFilePath: string, dataDir: string): Promise<void> {
  await ensureDir(path.dirname(path.resolve(configFilePath)));
  await writeFile(path.resolve(configFilePath), YAML.stringify(buildSeedConfig(dataDir)), "utf8");
}
