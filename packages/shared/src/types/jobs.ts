import { LLMCost } from './database';

export interface JobData {
  type: 'process-episode' | 'cleanup';
  episodeGuid?: string;
  podcastId?: string;
  reason?: 'background' | 'manual';
  options?: any;
}

export interface JobContext {
  jobId: number;
  startTime: Date;
  updateProgress: (progress: number, step?: string) => Promise<void>;
  recordLLMCost: (cost: Omit<LLMCost, 'id' | 'jobId' | 'createdAt'>) => Promise<void>;
  recordStep: (name: string) => Promise<void>;
}
