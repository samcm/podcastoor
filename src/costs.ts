import type { AppConfig, EffectivePodcastConfig, Transcript } from "./types.js";
import { readJson, writeJson } from "./utils.js";
import path from "node:path";

export interface CostEstimate {
  estimatedUsd: number;
  notes: string[];
}

interface CostLedger {
  month: string;
  actualUsd: number;
  estimatedUsd: number;
  llmCalls: number;
  runs: Array<{ at: string; podcastSlug: string; episodeKey: string; estimatedUsd: number; actualUsd: number; llmCalls: number; notes: string[] }>;
}

export interface CostSummary {
  month: string;
  monthlyBudgetUsd: number;
  actualUsd: number;
  estimatedUsd: number;
  remainingUsd: number;
  llmCalls: number;
  byDay: Array<{ day: string; actualUsd: number; estimatedUsd: number; llmCalls: number; failures: number }>;
  byPodcast: Array<{ podcastSlug: string; actualUsd: number; estimatedUsd: number; llmCalls: number; episodes: number }>;
  byEpisode: Array<{ podcastSlug: string; episodeKey: string; actualUsd: number; estimatedUsd: number; llmCalls: number }>;
  byModel: Array<{ model: string; actualUsd: number; entries: number }>;
  byStage: Array<{ stage: string; actualUsd: number; entries: number }>;
}

export function estimateEpisodeCost(podcast: EffectivePodcastConfig, transcript: Transcript | undefined, durationSeconds?: number): CostEstimate {
  const notes: string[] = [];
  let estimatedUsd = 0;

  if (transcript?.usage?.provider === "openrouter" && transcript.usage.costUsd != null) {
    estimatedUsd += transcript.usage.costUsd;
    notes.push(`OpenRouter transcript actual: ${((transcript.usage.seconds ?? 0) / 60).toFixed(1)} min on ${transcript.usage.model} = $${transcript.usage.costUsd.toFixed(6)}`);
  } else if (!transcript && podcast.transcripts.providers.openRouter.enabled && durationSeconds != null) {
    const minutes = durationSeconds / 60;
    const cost = minutes * podcast.transcripts.providers.openRouter.estimatedCostPerMinuteUsd;
    estimatedUsd += cost;
    notes.push(`OpenRouter transcript estimate: ${minutes.toFixed(1)} min x $${podcast.transcripts.providers.openRouter.estimatedCostPerMinuteUsd}/min on ${podcast.transcripts.providers.openRouter.model}`);
  }

  if (!transcript && podcast.transcripts.providers.openai.enabled && durationSeconds != null) {
    const minutes = durationSeconds / 60;
    const cost = minutes * podcast.transcripts.providers.openai.estimatedCostPerMinuteUsd;
    estimatedUsd += cost;
    notes.push(`OpenAI transcription estimate: ${minutes.toFixed(1)} min x $${podcast.transcripts.providers.openai.estimatedCostPerMinuteUsd}/min`);
  }

  if (podcast.llm.enabled && transcript?.text) {
    const windows = estimateClassifierWindows(transcript);
    const inputTokens = Math.ceil(Math.min(transcript.text.length, podcast.llm.maxTranscriptChars) / 4);
    const outputTokens = 700 * windows;
    const inputCost = (inputTokens / 1_000_000) * podcast.llm.estimatedInputUsdPerMillion;
    const outputCost = (outputTokens / 1_000_000) * podcast.llm.estimatedOutputUsdPerMillion;
    estimatedUsd += inputCost + outputCost;
    notes.push(`OpenRouter estimate: ${inputTokens} input tokens + ${outputTokens} output tokens across ${windows} windows on ${podcast.llm.model}`);
  }

  return { estimatedUsd: Number(estimatedUsd.toFixed(6)), notes };
}

function estimateClassifierWindows(transcript: Transcript): number {
  const lastEnd = transcript.segments.at(-1)?.end;
  const durationSeconds = lastEnd && Number.isFinite(lastEnd) ? lastEnd : transcript.usage?.seconds;
  if (!durationSeconds || durationSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(durationSeconds / 300));
}

export async function recordCost(
  config: AppConfig,
  entry: { podcastSlug: string; episodeKey: string; estimatedUsd: number; actualUsd: number; llmCalls: number; notes: string[] }
): Promise<void> {
  const ledgerPath = path.join(config.storage.dataDir, "usage", "costs.json");
  const month = new Date().toISOString().slice(0, 7);
  const current = (await readJson<Partial<CostLedger>>(ledgerPath)) ?? { month, actualUsd: 0, estimatedUsd: 0, llmCalls: 0, runs: [] };
  const ledger: CostLedger =
    current.month === month
      ? {
          month,
          actualUsd: current.actualUsd ?? 0,
          estimatedUsd: current.estimatedUsd ?? 0,
          llmCalls: current.llmCalls ?? current.runs?.reduce((sum, run) => sum + (run.llmCalls ?? 0), 0) ?? 0,
          runs: (current.runs ?? []).map((run) => ({ ...run, llmCalls: run.llmCalls ?? 0 }))
        }
      : { month, actualUsd: 0, estimatedUsd: 0, llmCalls: 0, runs: [] };
  ledger.actualUsd = Number((ledger.actualUsd + entry.actualUsd).toFixed(6));
  ledger.estimatedUsd = Number((ledger.estimatedUsd + entry.estimatedUsd).toFixed(6));
  ledger.llmCalls += entry.llmCalls;
  ledger.runs.push({ at: new Date().toISOString(), ...entry });
  await writeJson(ledgerPath, ledger);
}

export async function readCostLedger(config: AppConfig): Promise<CostLedger | undefined> {
  return readJson<CostLedger>(path.join(config.storage.dataDir, "usage", "costs.json"));
}

export async function summarizeCosts(config: AppConfig): Promise<CostSummary> {
  const ledger = await readCostLedger(config);
  const month = ledger?.month ?? new Date().toISOString().slice(0, 7);
  const runs = ledger?.runs ?? [];
  const byDay = new Map<string, { day: string; actualUsd: number; estimatedUsd: number; llmCalls: number; failures: number }>();
  const byPodcast = new Map<string, { podcastSlug: string; actualUsd: number; estimatedUsd: number; llmCalls: number; episodes: Set<string> }>();
  const byEpisode = new Map<string, { podcastSlug: string; episodeKey: string; actualUsd: number; estimatedUsd: number; llmCalls: number }>();
  const byModel = new Map<string, { model: string; actualUsd: number; entries: number }>();
  const byStage = new Map<string, { stage: string; actualUsd: number; entries: number }>();

  for (const run of runs) {
    const day = run.at.slice(0, 10);
    const dayEntry = byDay.get(day) ?? { day, actualUsd: 0, estimatedUsd: 0, llmCalls: 0, failures: 0 };
    dayEntry.actualUsd += run.actualUsd;
    dayEntry.estimatedUsd += run.estimatedUsd;
    dayEntry.llmCalls += run.llmCalls;
    byDay.set(day, dayEntry);

    const podcastEntry = byPodcast.get(run.podcastSlug) ?? { podcastSlug: run.podcastSlug, actualUsd: 0, estimatedUsd: 0, llmCalls: 0, episodes: new Set<string>() };
    podcastEntry.actualUsd += run.actualUsd;
    podcastEntry.estimatedUsd += run.estimatedUsd;
    podcastEntry.llmCalls += run.llmCalls;
    podcastEntry.episodes.add(run.episodeKey);
    byPodcast.set(run.podcastSlug, podcastEntry);

    const episodeKey = `${run.podcastSlug}:${run.episodeKey}`;
    const episodeEntry = byEpisode.get(episodeKey) ?? { podcastSlug: run.podcastSlug, episodeKey: run.episodeKey, actualUsd: 0, estimatedUsd: 0, llmCalls: 0 };
    episodeEntry.actualUsd += run.actualUsd;
    episodeEntry.estimatedUsd += run.estimatedUsd;
    episodeEntry.llmCalls += run.llmCalls;
    byEpisode.set(episodeKey, episodeEntry);

    let attributedActualUsd = 0;
    for (const note of run.notes ?? []) {
      const parsed = parseActualCostNote(note);
      if (!parsed) continue;
      attributedActualUsd += parsed.actualUsd;
      const modelEntry = byModel.get(parsed.model) ?? { model: parsed.model, actualUsd: 0, entries: 0 };
      modelEntry.actualUsd += parsed.actualUsd;
      modelEntry.entries += 1;
      byModel.set(parsed.model, modelEntry);
      const stageEntry = byStage.get(parsed.stage) ?? { stage: parsed.stage, actualUsd: 0, entries: 0 };
      stageEntry.actualUsd += parsed.actualUsd;
      stageEntry.entries += 1;
      byStage.set(parsed.stage, stageEntry);
    }
    const unattributedActualUsd = Number((run.actualUsd - attributedActualUsd).toFixed(6));
    if (unattributedActualUsd > 0.000001) {
      const modelEntry = byModel.get("unattributed legacy") ?? { model: "unattributed legacy", actualUsd: 0, entries: 0 };
      modelEntry.actualUsd += unattributedActualUsd;
      modelEntry.entries += 1;
      byModel.set(modelEntry.model, modelEntry);
      const stageEntry = byStage.get("unattributed") ?? { stage: "unattributed", actualUsd: 0, entries: 0 };
      stageEntry.actualUsd += unattributedActualUsd;
      stageEntry.entries += 1;
      byStage.set(stageEntry.stage, stageEntry);
    }
  }

  const actualUsd = ledger?.actualUsd ?? 0;
  return {
    month,
    monthlyBudgetUsd: config.costs.monthlyBudgetUsd,
    actualUsd,
    estimatedUsd: ledger?.estimatedUsd ?? 0,
    remainingUsd: Number((config.costs.monthlyBudgetUsd - actualUsd).toFixed(6)),
    llmCalls: ledger?.llmCalls ?? 0,
    byDay: [...byDay.values()].map(roundCostRow).sort((a, b) => b.day.localeCompare(a.day)),
    byPodcast: [...byPodcast.values()]
      .map((entry) => ({ ...roundCostRow(entry), episodes: entry.episodes.size }))
      .sort((a, b) => b.actualUsd - a.actualUsd),
    byEpisode: [...byEpisode.values()].map(roundCostRow).sort((a, b) => b.actualUsd - a.actualUsd).slice(0, 50),
    byModel: [...byModel.values()].map(roundCostRow).sort((a, b) => b.actualUsd - a.actualUsd),
    byStage: [...byStage.values()].map(roundCostRow).sort((a, b) => b.actualUsd - a.actualUsd)
  };
}

function parseActualCostNote(note: string): { stage: string; model: string; actualUsd: number } | undefined {
  if (!/\bactual:/i.test(note)) return undefined;
  const match = /\b(transcript|ad-detection|chapter-generation)\s+actual:[\s\S]*?\bon\s+([^=|]+?)\s*=\s*\$([0-9]+(?:\.[0-9]+)?)/i.exec(note);
  if (!match) return undefined;
  const purpose = match[1].toLowerCase();
  return {
    stage: purpose === "transcript" ? "transcription" : "text-llm",
    model: match[2].trim(),
    actualUsd: Number(match[3])
  };
}

function roundCostRow<T extends Record<string, unknown>>(row: T): T {
  const next: Record<string, unknown> = { ...row };
  for (const key of ["actualUsd", "estimatedUsd", "remainingUsd"]) {
    if (typeof next[key] === "number") next[key] = Number((next[key] as number).toFixed(6));
  }
  return next as T;
}

export async function assertBudget(config: AppConfig, estimatedRunUsd: number): Promise<void> {
  if (estimatedRunUsd > config.costs.perRunBudgetUsd) {
    throw new Error(`Estimated run cost $${estimatedRunUsd.toFixed(4)} exceeds per-run budget $${config.costs.perRunBudgetUsd.toFixed(2)}`);
  }
  const ledgerPath = path.join(config.storage.dataDir, "usage", "costs.json");
  const ledger = await readJson<CostLedger>(ledgerPath);
  if (ledger?.month === new Date().toISOString().slice(0, 7) && ledger.actualUsd + estimatedRunUsd > config.costs.monthlyBudgetUsd) {
    throw new Error(`Estimated monthly cost would exceed budget $${config.costs.monthlyBudgetUsd.toFixed(2)}`);
  }
}
