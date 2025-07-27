import { UpstreamEpisode, ProcessingJob, StoredChapter, AdRemoval, LLMCost, ProcessingResult } from './database';
import { AdSegment } from './index';

export interface EpisodeDetails {
  upstream: UpstreamEpisode;
  job?: ProcessingJob;
  result?: ProcessingResult;
  chapters: StoredChapter[];
  adRemovals: AdRemoval[];
  adSegments?: AdSegment[];
  llmCosts: LLMCost[];
}

export interface CreateJobRequest {
  episodeGuid: string;
  priority?: number;
}

export interface JobStatusResponse {
  job: ProcessingJob;
  llmCosts: LLMCost[];
  progress: number;
  currentStep?: string;
}

export interface AudioProxyParams {
  episodeGuid: string;
}

// Frontend-specific API response types
export interface PodcastStats {
  episodeCount: number;
  processedCount: number;
  totalAdsRemoved: number;
  totalTimeSaved: number; // in seconds
  estimatedMoneySaved: number; // in cents
  averageAdsPerEpisode: number;
}

export interface Podcast {
  id: string;
  title: string;
  description: string;
  feedUrl: string;
  rssFeedUrl: string;
  imageUrl?: string;
  author?: string;
  lastProcessed?: Date;
  episodeCount?: number;
  processedEpisodeCount?: number;
  processingProgress?: number;
}

export interface Episode {
  episodeGuid: string;
  title: string;
  description: string;
  publishDate: Date;
  duration: number;
  audioUrl: string;
  processedUrl?: string;
  fileSize: number;
  hasResult: boolean;
  jobStatus?: 'pending' | 'running' | 'completed' | 'failed';
  imageUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  adsRemoved?: number;
  podcastId: string;
}
