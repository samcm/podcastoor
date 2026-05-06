import type { CategoryConfig, Chapter, EpisodeManifest, ParsedEpisode, Transcript } from "./types.js";
import { writeEpisodeJson } from "./storage.js";
import type { AppConfig } from "./types.js";

export interface PodcastIndexChapters {
  version: string;
  chapters: Array<{
    startTime: number;
    title: string;
    url?: string;
    img?: string;
  }>;
}

export function buildChapters(episode: ParsedEpisode, transcript: Transcript | undefined, categories: CategoryConfig): Chapter[] {
  if (episode.chapters.length > 0) {
    return normalizeChapters(tagCategoryChapters(episode.chapters, categories));
  }

  if (transcript?.segments.length) {
    return normalizeChapters(deriveLooseChaptersFromTranscript(transcript, categories));
  }

  return [];
}

export function normalizeChapters(chapters: Chapter[], maxItems = 10): Chapter[] {
  const seen = new Set<string>();
  const cleaned: Chapter[] = [];

  for (const chapter of chapters.sort((a, b) => a.startTime - b.startTime)) {
    const title = cleanChapterTitle(chapter.title);
    if (!title || shouldDropChapter(title)) continue;
    const key = `${Math.round(chapter.startTime)}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ ...chapter, title });
    if (cleaned.length >= maxItems) break;
  }

  return cleaned;
}

export function toPodcastIndexChapters(chapters: Chapter[]): PodcastIndexChapters {
  return {
    version: "1.2.0",
    chapters: chapters.map((chapter) => ({
      startTime: Number(chapter.startTime.toFixed(3)),
      title: chapter.title,
      ...(chapter.url ? { url: chapter.url } : {}),
      ...(chapter.img ? { img: chapter.img } : {})
    }))
  };
}

export async function writeChapters(config: AppConfig, manifest: EpisodeManifest): Promise<string | undefined> {
  if (manifest.chapters.length === 0) return undefined;
  return writeEpisodeJson(config, manifest.podcastSlug, manifest.episodeKey, "chaptersJson", toPodcastIndexChapters(normalizeChapters(manifest.chapters)));
}

function tagCategoryChapters(chapters: Chapter[], categories: CategoryConfig): Chapter[] {
  return chapters.map((chapter) => {
    const muted = categories.muted.find((category) => equalsTopic(chapter.title, category));
    const preferred = categories.preferred.find((category) => equalsTopic(chapter.title, category));
    if (muted) return { ...chapter, title: `${chapter.title} [muted-topic]` };
    if (preferred) return { ...chapter, title: `${chapter.title} [preferred-topic]` };
    return chapter;
  });
}

function deriveLooseChaptersFromTranscript(transcript: Transcript, categories: CategoryConfig): Chapter[] {
  const chapters: Chapter[] = [{ startTime: 0, title: "Start" }];
  for (const segment of transcript.segments) {
    const found = [...categories.preferred, ...categories.muted].find((category) => segment.text.toLowerCase().includes(category.toLowerCase()));
    if (found && chapters.every((chapter) => Math.abs(chapter.startTime - segment.start) > 90)) {
      chapters.push({ startTime: segment.start, title: found });
    }
  }
  return tagCategoryChapters(chapters, categories);
}

function equalsTopic(title: string, topic: string): boolean {
  return title.toLowerCase().split(/[^a-z0-9]+/i).includes(topic.toLowerCase());
}

function cleanChapterTitle(value: string): string {
  const withoutTags = value
    .replace(/\[[^\]]+\]/g, "")
    .replace(/^(discussion|segment|topic|chapter|game|interview)\s*:\s*/i, "")
    .replace(/\s+-\s+/g, " ")
    .replace(/[^\w\s'&/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lowered = withoutTags.toLowerCase();
  if (lowered === "start" || lowered === "podcast intro") return "Intro";

  const words = withoutTags
    .split(/\s+/)
    .filter((word) => !["and", "with", "the", "a", "an", "on", "of", "to", "for", "in", "discussion"].includes(word.toLowerCase()))
    .slice(0, 4);

  return words.map(titleCaseWord).join(" ");
}

function shouldDropChapter(title: string): boolean {
  return /\b(ad|ads|advertisement|sponsor|sponsored|promo|event promo|live event|good day|yo pro|neds|shopify|betterhelp|sprite|bikes online|rolling insurance|rollin insurance|sbs insight)\b/i.test(
    title
  );
}

function titleCaseWord(word: string): string {
  const allCaps = new Set(["NRL", "AFL", "NBA", "IPL", "PNG", "RCB", "KKR", "LIV", "SBS"]);
  const upper = word.toUpperCase();
  if (allCaps.has(upper)) return upper;
  return word.charAt(0).toUpperCase() + word.slice(1);
}
