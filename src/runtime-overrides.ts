import path from "node:path";
import type { AppConfig } from "./types.js";
import { deepMerge, readJson, writeJson } from "./utils.js";

export interface RuntimeTuning {
  processing?: {
    confidenceThreshold?: number;
  };
  detection?: {
    paddingSeconds?: number;
    prePaddingSeconds?: number;
    postPaddingSeconds?: number;
    minSegmentSeconds?: number;
    maxSegmentSeconds?: number;
  };
  audio?: {
    jingle?: {
      enabled?: boolean;
    };
  };
}

export interface RuntimeOverrides {
  schemaVersion: 1;
  updatedAt: string;
  global?: RuntimeTuning;
  podcasts?: Record<string, RuntimeTuning>;
}

export async function loadRuntimeOverrides(config: AppConfig): Promise<RuntimeOverrides> {
  return (
    (await readJson<RuntimeOverrides>(runtimeOverridesPath(config))) ?? {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      podcasts: {}
    }
  );
}

export async function saveRuntimeOverrides(config: AppConfig, overrides: RuntimeOverrides): Promise<void> {
  overrides.schemaVersion = 1;
  overrides.updatedAt = new Date().toISOString();
  await writeJson(runtimeOverridesPath(config), overrides);
}

export async function applyRuntimeOverrides(config: AppConfig): Promise<AppConfig> {
  const overrides = await loadRuntimeOverrides(config);
  return applyRuntimeOverridesObject(config, overrides);
}

export function applyRuntimeOverridesObject(config: AppConfig, overrides: RuntimeOverrides): AppConfig {
  let next = structuredClone(config);
  if (overrides.global) {
    next = deepMerge(next, tuningToConfigOverride(overrides.global));
  }
  for (const [slug, tuning] of Object.entries(overrides.podcasts ?? {})) {
    if (!next.podcasts[slug]) continue;
    next.podcasts[slug] = deepMerge(next.podcasts[slug], tuningToPodcastOverride(tuning));
  }
  return next;
}

export async function updateRuntimeTuning(
  config: AppConfig,
  scope: { type: "global" } | { type: "podcast"; podcastSlug: string },
  tuning: RuntimeTuning
): Promise<RuntimeOverrides> {
  const overrides = await loadRuntimeOverrides(config);
  if (scope.type === "global") {
    overrides.global = deepMerge(overrides.global ?? {}, tuning);
  } else {
    overrides.podcasts ??= {};
    overrides.podcasts[scope.podcastSlug] = deepMerge(overrides.podcasts[scope.podcastSlug] ?? {}, tuning);
  }
  await saveRuntimeOverrides(config, overrides);
  return overrides;
}

function tuningToConfigOverride(tuning: RuntimeTuning): Partial<AppConfig> {
  return tuningToPodcastOverride(tuning) as Partial<AppConfig>;
}

function tuningToPodcastOverride(tuning: RuntimeTuning): Record<string, unknown> {
  return {
    ...(tuning.processing ? { processing: tuning.processing } : {}),
    ...(tuning.detection ? { detection: tuning.detection } : {}),
    ...(tuning.audio ? { audio: tuning.audio } : {})
  };
}

function runtimeOverridesPath(config: AppConfig): string {
  return path.join(config.storage.dataDir, "config", "runtime-overrides.json");
}
