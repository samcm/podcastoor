import { z } from 'zod';

export const PodcastConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rssUrl: z.string().url(),
  enabled: z.boolean(),
  retentionDays: z.number().positive(),
  processingOptions: z.object({
    removeAds: z.boolean(),
    generateChapters: z.boolean(),
    transcriptionModel: z.string().min(1),
    chunkSizeMinutes: z.number().positive(),
    overlapSeconds: z.number().nonnegative(),
    minAdDuration: z.number().nonnegative().optional()
  })
});

export const AdDetectionSchema = z.object({
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  adType: z.enum(['pre-roll', 'mid-roll', 'post-roll', 'embedded']),
  description: z.string().optional()
});

export const ChapterSchema = z.object({
  title: z.string().min(1),
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  description: z.string().optional()
});

export const ProcessingResultSchema = z.object({
  id: z.number().optional(),
  podcastId: z.string().min(1),
  episodeId: z.string().min(1),
  originalUrl: z.string().url(),
  processedUrl: z.string().url(),
  adsRemoved: z.array(AdDetectionSchema),
  chapters: z.array(ChapterSchema),
  processingCost: z.number().nonnegative(),
  processedAt: z.date()
});

export const StorageConfigSchema = z.object({
  provider: z.enum(['minio', 'r2']),
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  region: z.string().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1)
});

export const LLMConfigSchema = z.object({
  transcriptionProvider: z.string().min(1),
  adDetectionProvider: z.string().min(1),
  apiKeys: z.record(z.string()),
  fallbackModels: z.array(z.string())
});