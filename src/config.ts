import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig, EffectivePodcastConfig } from "./types.js";
import { deepMerge, resolveFrom, unique } from "./utils.js";

const configSchema = z
  .object({
    server: z.object({
      host: z.string(),
      port: z.number().int().positive(),
      publicBaseUrl: z.string().url()
    }),
    storage: z.object({
      dataDir: z.string()
    }),
    podcasts: z.record(
      z.object({
        name: z.string(),
        feedUrl: z.string().url()
      }).passthrough()
    )
  })
  .passthrough();

export const defaultConfig: AppConfig = {
  server: {
    host: "0.0.0.0",
    port: 3729,
    publicBaseUrl: "http://localhost:3729"
  },
  storage: {
    dataDir: "./data"
  },
  processing: {
    lookbackDays: 7,
    maxEpisodesPerRun: 20,
    concurrency: 1,
    dryRun: false,
    downloadAudio: true,
    force: false,
    confidenceThreshold: 0.72,
    preserveUnknownSegments: true
  },
  automation: {
    enabled: true,
    processOnStartup: true,
    intervalMinutes: 60
  },
  costs: {
    monthlyBudgetUsd: 10,
    perRunBudgetUsd: 1,
    transcribeMaxMinutesPerRun: 180,
    llmMaxInputTokensPerRun: 250000,
    llmMaxOutputTokensPerRun: 20000
  },
  audio: {
    outputBitrateKbps: 192,
    preserveSourceQuality: true,
    jingle: {
      enabled: true,
      frequencyHz: 880,
      durationSeconds: 0.35,
      gainDb: -12
    }
  },
  transcripts: {
    preferred: "openRouter",
    providers: {
      feed: { enabled: true },
      pocketCasts: { enabled: false, experimental: true, endpointTemplate: "" },
      openRouter: {
        enabled: true,
        model: "openai/whisper-large-v3-turbo",
        language: "en",
        chunkSeconds: 10,
        concurrency: 2,
        estimatedCostPerMinuteUsd: 0.000667
      },
      openai: { enabled: false, model: "gpt-4o-mini-transcribe", estimatedCostPerMinuteUsd: 0.003 }
    }
  },
  llm: {
    provider: "openrouter",
    enabled: true,
    model: "deepseek/deepseek-v4-pro",
    estimatedInputUsdPerMillion: 0.435,
    estimatedOutputUsdPerMillion: 0.87,
    maxTranscriptChars: 180000
  },
  detection: {
    paddingSeconds: 0.6,
    minSegmentSeconds: 8,
    maxSegmentSeconds: 240,
    adKeywords: [
      "sponsored by",
      "this episode is brought to you by",
      "use code",
      "promo code",
      "discount code",
      "free trial",
      "exclusive offer",
      "terms and conditions",
      "support is available"
    ],
    dynamicAdMarkerPhrases: ["advertisement", "ad break"]
  },
  categories: {
    preferred: ["NRL", "cricket", "football"],
    muted: ["AFL"]
  },
  podcasts: {}
};

export function defaultConfigPath(): string {
  const configPath = process.env.CONFIG_PATH;
  const configFile = process.env.CONFIG_FILE ?? "config.yaml";
  return configPath ? path.join(configPath, configFile) : "config.example.yaml";
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<AppConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const parsed = normalizeRawConfig(YAML.parse(await readFile(absoluteConfigPath, "utf8")) as Record<string, unknown>);
  const merged = applyEnvOverrides(deepMerge(defaultConfig, parsed));
  merged.storage.dataDir = resolveFrom(configDir, merged.storage.dataDir);
  return configSchema.parse(merged) as unknown as AppConfig;
}

function normalizeRawConfig(raw: Record<string, unknown>): Partial<AppConfig> {
  if (!Array.isArray(raw.podcasts)) return raw as Partial<AppConfig>;

  const podcasts: AppConfig["podcasts"] = {};
  for (const podcast of raw.podcasts) {
    if (!podcast || typeof podcast !== "object") continue;
    const entry = podcast as Record<string, unknown>;
    if (entry.enabled === false) continue;
    const slug = String(entry.id ?? entry.slug ?? entry.name ?? "").trim();
    const feedUrl = String(entry.rssUrl ?? entry.feedUrl ?? "").trim();
    const name = String(entry.name ?? slug).trim();
    if (!slug || !feedUrl || !name) continue;
    podcasts[slug] = {
      name,
      feedUrl,
      lookbackDays: typeof entry.retentionDays === "number" ? entry.retentionDays : undefined
    };
  }

  return {
    server: {
      host: "0.0.0.0",
      port: Number(process.env.PORT ?? 3000),
      publicBaseUrl: String(raw.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000")
    },
    storage: {
      dataDir: String(raw.dataDir ?? process.env.STORAGE_BASE_DIR ?? "./data")
    },
    podcasts
  } as Partial<AppConfig>;
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  return {
    ...config,
    server: {
      ...config.server,
      port: Number.isFinite(port) && port ? port : config.server.port,
      publicBaseUrl: process.env.PUBLIC_URL || config.server.publicBaseUrl
    },
    storage: {
      ...config.storage,
      dataDir: process.env.STORAGE_BASE_DIR || process.env.DATA_DIR || config.storage.dataDir
    }
  };
}

export function resolvePodcastConfig(config: AppConfig, slug: string): EffectivePodcastConfig {
  const override = config.podcasts[slug];
  if (!override) {
    throw new Error(`Unknown podcast '${slug}'. Available podcasts: ${Object.keys(config.podcasts).join(", ")}`);
  }

  const detection = deepMerge(config.detection, override.detection ?? {});
  detection.adKeywords = unique([...(config.detection.adKeywords ?? []), ...((override.detection?.adKeywords as string[] | undefined) ?? [])]);
  detection.dynamicAdMarkerPhrases = unique([
    ...(config.detection.dynamicAdMarkerPhrases ?? []),
    ...((override.detection?.dynamicAdMarkerPhrases as string[] | undefined) ?? [])
  ]);

  const categories = deepMerge(config.categories, override.categories ?? {});
  categories.preferred = unique([...(config.categories.preferred ?? []), ...((override.categories?.preferred as string[] | undefined) ?? [])]);
  categories.muted = unique([...(config.categories.muted ?? []), ...((override.categories?.muted as string[] | undefined) ?? [])]);

  const processing = {
    ...config.processing,
    lookbackDays: override.lookbackDays ?? config.processing.lookbackDays,
    maxEpisodesPerRun: override.maxEpisodesPerRun ?? config.processing.maxEpisodesPerRun
  };

  return {
    ...override,
    slug,
    processing,
    detection,
    categories,
    transcripts: deepMerge(config.transcripts, override.transcripts ?? {}),
    llm: deepMerge(config.llm, override.llm ?? {})
  };
}
