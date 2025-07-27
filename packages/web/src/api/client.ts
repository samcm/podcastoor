const API_BASE = (import.meta as any).env?.VITE_API_URL || '/api';

export interface Show {
  id: string;
  title: string;
  description?: string;
  feedUrl: string;
  createdAt: Date;
  updatedAt: Date;
  episodeCount?: number;
  processedCount?: number;
}

export interface Episode {
  guid: string;
  showId: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
  showTitle?: string;
  hasJob?: boolean;
  jobStatus?: string;
  processedAt?: Date;
}

export interface Job {
  id: number;
  episodeGuid: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  priority: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProcessedEpisode {
  jobId: number;
  processedUrl: string;
  originalDuration: number;
  processedDuration: number;
  processingCost?: number;
  createdAt: Date;
}

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
}

export interface AdDetection {
  startTime: number;
  endTime: number;
  confidence: number;
  adType?: string;
  description: string;
}

export interface EpisodeDetails {
  episode: Episode;
  job: Job | null;
  processedEpisode: ProcessedEpisode | null;
  chapters: Chapter[];
  ads: AdDetection[];
}

export interface ShowStats {
  episodeCount: number;
  processedCount: number;
  totalAdsRemoved: number;
  totalTimeSaved: number;
  averageAdsPerEpisode: number;
}

export interface HealthStatus {
  status: string;
  timestamp: string;
  shows: number;
  jobs: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  lastProcessingRun: Date;
}

export const api = {
  // Health check
  async getHealth(): Promise<HealthStatus> {
    const res = await fetch('/health');
    if (!res.ok) throw new Error('Failed to fetch health status');
    return res.json();
  },

  // Shows
  async getShows(): Promise<Show[]> {
    const res = await fetch(`${API_BASE}/shows`);
    if (!res.ok) throw new Error('Failed to fetch shows');
    return res.json();
  },

  async getShow(showId: string): Promise<Show> {
    const res = await fetch(`${API_BASE}/shows/${showId}`);
    if (!res.ok) throw new Error('Failed to fetch show');
    return res.json();
  },

  async getShowStats(showId: string): Promise<ShowStats> {
    const res = await fetch(`${API_BASE}/shows/${showId}/stats`);
    if (!res.ok) throw new Error('Failed to fetch show stats');
    return res.json();
  },

  async getShowEpisodes(showId: string): Promise<Episode[]> {
    const res = await fetch(`${API_BASE}/shows/${showId}/episodes`);
    if (!res.ok) throw new Error('Failed to fetch episodes');
    return res.json();
  },

  // Episodes
  async getEpisode(episodeGuid: string): Promise<EpisodeDetails> {
    const res = await fetch(`${API_BASE}/episodes/${episodeGuid}`);
    if (!res.ok) throw new Error('Failed to fetch episode');
    return res.json();
  },

  async getRecentEpisodes(): Promise<{ episodes: Episode[]; count: number }> {
    const res = await fetch(`${API_BASE}/episodes/recent`);
    if (!res.ok) throw new Error('Failed to fetch recent episodes');
    return res.json();
  },

  // Jobs
  async createJob(episodeGuid: string, priority?: number): Promise<{ success: boolean; jobId: number; message: string }> {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeGuid, priority })
    });
    if (!res.ok) throw new Error('Failed to create job');
    return res.json();
  },

  async getJobStats(): Promise<{ isRunning: boolean; runningJobs: number; maxConcurrency: number; jobStats: any }> {
    const res = await fetch(`${API_BASE}/jobs/stats`);
    if (!res.ok) throw new Error('Failed to fetch job stats');
    return res.json();
  },

  // Processing
  async processShow(showId: string): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/process/${showId}`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to process show');
    return res.json();
  },

  async processAll(): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/process-all`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to process all shows');
    return res.json();
  },

  // Audio
  getAudioUrl(episodeGuid: string): string {
    return `/audio/${episodeGuid}`;
  }
};

// Legacy type exports for compatibility
export type Podcast = Show;
export type PodcastStats = ShowStats;