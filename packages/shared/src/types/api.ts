import { UpstreamEpisode, ProcessingJob, StoredChapter, AdRemoval, LLMCost, ProcessingResult } from './database';

export interface EpisodeDetails {
  upstream: UpstreamEpisode;
  job?: ProcessingJob;
  result?: ProcessingResult;
  chapters: StoredChapter[];
  adRemovals: AdRemoval[];
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
