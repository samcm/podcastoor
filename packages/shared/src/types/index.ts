export interface PodcastConfig {
  id: string;
  name: string;
  rssUrl: string;
  enabled: boolean;
  retentionDays: number;
  processingOptions: ProcessingOptions;
}

export interface ProcessingOptions {
  removeAds: boolean;
  generateChapters: boolean;
  chunkSizeMinutes: number;
  overlapSeconds: number;
}

export interface AdDetection {
  startTime: number;
  endTime: number;
  confidence: number;
  adType: 'pre-roll' | 'mid-roll' | 'post-roll' | 'embedded';
  description?: string;
}

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
}

export interface ProcessingResult {
  podcastId: string;
  episodeId: string;
  originalUrl: string;
  processedUrl: string;
  adsRemoved: AdDetection[];
  chapters: Chapter[];
  processingCost: number;
  processedAt: Date;
}

export interface Episode {
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
}

export interface ProcessedEpisode extends Episode {
  processedAudioUrl: string;
  chapters: Chapter[];
  adsRemoved: AdDetection[];
  enhancedDescription: string;
}

export interface AudioMetadata {
  duration: number;
  format: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
  size: number;
}

export interface StorageConfig {
  provider: 'minio' | 'r2';
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface JobConfig {
  redisUrl: string;
  concurrency: number;
  retryAttempts: number;
}