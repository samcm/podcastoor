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
    const outputTokens = 900 * windows;
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
  return Math.max(1, Math.ceil(durationSeconds / 600));
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
