import path from "node:path";
import type { AppConfig } from "./types.js";
import { readJson, writeJson, slugify } from "./utils.js";

export interface StoredPodcast {
  name: string;
  feedUrl: string;
  host?: string;
  accentColor?: string;
  description?: string;
}

export type AddedPodcasts = Record<string, StoredPodcast>;

function storePath(dataDir: string): string {
  return path.join(dataDir, "config", "podcasts.json");
}

export async function readAddedPodcasts(dataDir: string): Promise<AddedPodcasts> {
  return (await readJson<AddedPodcasts>(storePath(dataDir))) ?? {};
}

export function uniqueSlug(taken: Set<string>, base: string): string {
  const root = slugify(base);
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}

export async function addPodcast(config: AppConfig, podcast: StoredPodcast & { slug: string }): Promise<void> {
  const store = await readAddedPodcasts(config.storage.dataDir);
  const { slug, ...rest } = podcast;
  store[slug] = rest;
  await writeJson(storePath(config.storage.dataDir), store);
}
