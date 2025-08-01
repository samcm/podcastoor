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
  minAdDuration?: number;
}

export interface AdDetection {
  startTime: number;
  endTime: number;
  confidence: number;
  adType: 'pre-roll' | 'mid-roll' | 'post-roll' | 'embedded';
  description?: string;
}

export interface AdSegment extends AdDetection {
  title?: string;
  audioUrl: string;
  duration: number;
}

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
}


export interface Episode {
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
  imageUrl?: string;
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


export interface ProcessingArtifacts {
  podcastId: string;
  episodeId: string;
  processedAt: string;
  audioMetadata: {
    original: AudioMetadata;
    processed: AudioMetadata;
  };
  speakerCount: number;
  initialAdsDetected: AdDetection[];
  finalAdsDetected: AdDetection[];
  adSegments?: AdSegment[];
  chapters: Chapter[];
  processingTime: {
    download: number;
    analysis: number;
    adRefinement: number;
    chapterGeneration: number;
    audioProcessing: number;
    upload: number;
  };
  timeSaved: number;
}

// Export new normalized schema types
export * from './database';
export * from './api';
export * from './jobs';