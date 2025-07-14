export interface UpstreamEpisode {
  id: number;
  podcastId: string;
  episodeGuid: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
  fileSize: number;
  importedAt: Date;
}

export interface ProcessingJob {
  id: number;
  episodeGuid: string;
  podcastId: string;
  reason: 'background' | 'manual';
  status: 'pending' | 'running' | 'completed' | 'failed';
  priority: number;
  attempts: number;
  lastError?: string;
  isProtected: boolean; // true for manual jobs
  progress: number;
  processingSteps?: ProcessingStep[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProcessingStep {
  name: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
}

export interface LLMCost {
  id: number;
  jobId: number;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  createdAt: Date;
}

export interface StoredChapter {
  id: number;
  jobId: number;
  episodeGuid: string;
  title: string;
  startTime: number;
  endTime: number;
  summary?: string;
  createdAt: Date;
}

export interface AdRemoval {
  id: number;
  jobId: number;
  episodeGuid: string;
  startTime: number;
  endTime: number;
  confidence: number;
  category: string;
  createdAt: Date;
}

import { AdDetection, Chapter } from './index';

export interface ProcessingResult {
  id?: number;
  podcastId: string;
  episodeId: string;
  originalUrl: string;
  processedUrl: string;
  adsRemoved: AdDetection[];
  chapters: Chapter[];
  processingCost: number;
  processedAt: Date;
}
