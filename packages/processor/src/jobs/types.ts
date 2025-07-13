import { ProcessingResult } from '@podcastoor/shared';

export interface JobResult {
  success: boolean;
  result?: ProcessingResult;
  error?: string;
  processingTime: number;
  cost: number;
}

export interface JobMetrics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageProcessingTime: number;
  totalCost: number;
  queueSize: number;
}

export interface WorkerConfig {
  concurrency: number;
  stalledInterval: number;
  maxStalledCount: number;
  retryDelay: number;
}

export interface QueueConfig {
  name: string;
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
  defaultJobOptions: {
    attempts: number;
    backoff: {
      type: 'fixed' | 'exponential';
      delay: number;
    };
    removeOnComplete: number;
    removeOnFail: number;
  };
}