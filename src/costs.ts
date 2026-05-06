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
  runs: Array<{ at: string; podcastSlug: string; episodeKey: string; estimatedUsd: number; actualUsd: number; notes: string[] }>;
}

export function estimateEpisodeCost(podcast: EffectivePodcastConfig, transcript: Transcript | undefined, durationSeconds?: number): CostEstimate {
  const notes: string[] = [];
  let estimatedUsd = 0;

  if (transcript?.usage?.provider === "openrouter" && transcript.usage.costUsd != null) {
    estimatedUsd += transcript.usage.costUsd;
    notes.push(`OpenRouter STT actual: ${((transcript.usage.seconds ?? 0) / 60).toFixed(1)} min on ${transcript.usage.model} = $${transcript.usage.costUsd.toFixed(6)}`);
  } else if (!transcript && podcast.transcripts.providers.openRouter.enabled && durationSeconds != null) {
    const minutes = durationSeconds / 60;
    const cost = minutes * podcast.transcripts.providers.openRouter.estimatedCostPerMinuteUsd;
    estimatedUsd += cost;
    notes.push(`OpenRouter STT estimate: ${minutes.toFixed(1)} min x $${podcast.transcripts.providers.openRouter.estimatedCostPerMinuteUsd}/min on ${podcast.transcripts.providers.openRouter.model}`);
  }

  if (!transcript && podcast.transcripts.providers.openai.enabled && durationSeconds != null) {
    const minutes = durationSeconds / 60;
    const cost = minutes * podcast.transcripts.providers.openai.estimatedCostPerMinuteUsd;
    estimatedUsd += cost;
    notes.push(`OpenAI transcription estimate: ${minutes.toFixed(1)} min x $${podcast.transcripts.providers.openai.estimatedCostPerMinuteUsd}/min`);
  }

  if (podcast.llm.enabled && transcript?.text) {
    const inputTokens = Math.ceil(Math.min(transcript.text.length, podcast.llm.maxTranscriptChars) / 4);
    const outputTokens = 1600;
    const inputCost = (inputTokens / 1_000_000) * podcast.llm.estimatedInputUsdPerMillion;
    const outputCost = (outputTokens / 1_000_000) * podcast.llm.estimatedOutputUsdPerMillion;
    estimatedUsd += inputCost + outputCost;
    notes.push(`OpenRouter estimate: ${inputTokens} input tokens + ${outputTokens} output tokens on ${podcast.llm.model}`);
  }

  return { estimatedUsd: Number(estimatedUsd.toFixed(6)), notes };
}

export async function recordCost(config: AppConfig, entry: { podcastSlug: string; episodeKey: string; estimatedUsd: number; actualUsd: number; notes: string[] }): Promise<void> {
  const ledgerPath = path.join(config.storage.dataDir, "usage", "costs.json");
  const month = new Date().toISOString().slice(0, 7);
  const current = (await readJson<CostLedger>(ledgerPath)) ?? { month, actualUsd: 0, estimatedUsd: 0, runs: [] };
  const ledger = current.month === month ? current : { month, actualUsd: 0, estimatedUsd: 0, runs: [] };
  ledger.actualUsd = Number((ledger.actualUsd + entry.actualUsd).toFixed(6));
  ledger.estimatedUsd = Number((ledger.estimatedUsd + entry.estimatedUsd).toFixed(6));
  ledger.runs.push({ at: new Date().toISOString(), ...entry });
  await writeJson(ledgerPath, ledger);
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
