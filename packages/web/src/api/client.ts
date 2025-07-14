import { EpisodeDetails, CreateJobRequest, JobStatusResponse } from '@podcastoor/shared';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export const api = {
  // Episode endpoints
  async getEpisode(episodeGuid: string): Promise<EpisodeDetails> {
    const res = await fetch(`${API_BASE}/episodes/${episodeGuid}`);
    if (!res.ok) throw new Error('Failed to fetch episode');
    return res.json();
  },
  
  async getShowEpisodes(podcastId: string): Promise<EpisodeDetails[]> {
    const res = await fetch(`${API_BASE}/shows/${podcastId}/episodes`);
    if (!res.ok) throw new Error('Failed to fetch episodes');
    return res.json();
  },
  
  // Job endpoints
  async createJob(episodeGuid: string, priority?: number): Promise<{ jobId: number }> {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeGuid, priority } as CreateJobRequest)
    });
    if (!res.ok) throw new Error('Failed to create job');
    return res.json();
  },
  
  async getJobStatus(jobId: number): Promise<JobStatusResponse> {
    const res = await fetch(`${API_BASE}/jobs/${jobId}`);
    if (!res.ok) throw new Error('Failed to fetch job status');
    return res.json();
  },
  
  async retryJob(jobId: number): Promise<void> {
    const res = await fetch(`${API_BASE}/jobs/${jobId}/retry`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to retry job');
  },
  
  // Audio URL helper
  getAudioUrl(episodeGuid: string): string {
    return `/audio/${episodeGuid}`;
  },
  
  // RSS URL helper
  getRssUrl(podcastId: string): string {
    return `/rss/${podcastId}`;
  },

  // Legacy endpoints (for backward compatibility during transition)
  async getPodcasts(): Promise<{ podcasts: any[], totalCount: number }> {
    const res = await fetch(`${API_BASE}/podcasts`);
    if (!res.ok) throw new Error('Failed to fetch podcasts');
    return res.json();
  },

  async getPodcast(podcastId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/podcasts/${podcastId}`);
    if (!res.ok) throw new Error('Failed to fetch podcast');
    return res.json();
  },

  async getPodcastEpisodes(podcastId: string): Promise<any[]> {
    const res = await fetch(`${API_BASE}/podcasts/${podcastId}/episodes`);
    if (!res.ok) throw new Error('Failed to fetch podcast episodes');
    return res.json();
  },

  async getHealth(): Promise<any> {
    const res = await fetch(`${API_BASE.replace('/api', '')}/health`);
    if (!res.ok) throw new Error('Failed to fetch health status');
    return res.json();
  },

  async getRecentEpisodes(): Promise<{ episodes: any[] }> {
    const res = await fetch(`${API_BASE}/episodes/recent`);
    if (!res.ok) throw new Error('Failed to fetch recent episodes');
    return res.json();
  },

  async getPodcastStats(podcastId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/podcasts/${podcastId}/stats`);
    if (!res.ok) throw new Error('Failed to fetch podcast stats');
    return res.json();
  },

  async processPodcast(podcastId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/podcasts/${podcastId}/process`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to process podcast');
  }
};