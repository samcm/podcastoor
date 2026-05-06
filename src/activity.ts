import path from "node:path";
import type { AppConfig } from "./types.js";
import { readJson, writeJson } from "./utils.js";

export interface ActivityEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  scope: "worker" | "server";
  message: string;
  podcastSlug?: string;
  episodeKey?: string;
  episodeTitle?: string;
  details?: Record<string, unknown>;
}

const MAX_EVENTS = 200;

export async function appendActivity(config: AppConfig, event: Omit<ActivityEvent, "id" | "at"> & { at?: string }): Promise<void> {
  const events = (await readRecentActivity(config, MAX_EVENTS)).reverse();
  const at = event.at ?? new Date().toISOString();
  events.push({
    ...event,
    at,
    id: `${Date.parse(at) || Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    details: cleanDetails(event.details)
  });
  await writeJson(activityPath(config), events.slice(-MAX_EVENTS));
}

export async function readRecentActivity(config: AppConfig, limit = 40): Promise<ActivityEvent[]> {
  const events = (await readJson<ActivityEvent[]>(activityPath(config))) ?? [];
  return events.slice(-limit).reverse();
}

function activityPath(config: AppConfig): string {
  return path.join(config.storage.dataDir, "activity", "events.json");
}

function cleanDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value == null) continue;
    if (value instanceof Error) {
      clean[key] = value.message;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
      continue;
    }
    clean[key] = JSON.parse(JSON.stringify(value));
  }
  return clean;
}
