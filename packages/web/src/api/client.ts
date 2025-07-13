const API_BASE = '/api'

export interface Podcast {
  id: string
  title: string
  description: string
  author: string
  imageUrl?: string
  feedUrl: string
  rssFeedUrl?: string
  episodeCount?: number
  processedEpisodeCount?: number
  processingProgress?: number
}

export interface Episode {
  id: number
  episodeGuid: string
  podcastId: string
  title: string
  description: string
  audioUrl: string
  publishDate: string
  duration?: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  processedAt?: string
  processedUrl?: string
  processingCost?: number
  failureReason?: string | null
  createdAt: string
  updatedAt: string
  podcastTitle?: string
  adsRemoved?: number
  chapters?: number
}

export interface PodcastStats {
  episodeCount: number
  processedCount: number
  totalAdsRemoved: number
  totalTimeSaved: number
  estimatedMoneySaved: number
}

export interface ProcessingArtifact {
  episodeId: string
  transcript?: string
  adsRemoved?: Array<{
    start: number
    end: number
    content: string
    confidence: number
  }>
  chapters?: Array<{
    start: number
    end: number
    title: string
    description?: string
  }>
  summary?: string
  keyTopics?: string[]
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy'
  timestamp: string
  stats?: {
    totalPodcasts: number
    totalEpisodes: number
    processedEpisodes: number
    failedEpisodes: number
    lastProcessingTime?: string
  }
}

class APIClient {
  async fetch<T>(path: string): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`)
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`)
    }
    return response.json()
  }

  async getHealth(): Promise<HealthStatus> {
    const response = await fetch('/health')
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`)
    }
    return response.json()
  }

  async getRecentEpisodes(limit = 20): Promise<{ episodes: Episode[], count: number }> {
    return this.fetch(`/episodes/recent?limit=${limit}`)
  }

  async getPodcasts(): Promise<{ podcasts: Podcast[], totalCount: number }> {
    return this.fetch('/podcasts')
  }

  async getPodcast(podcastId: string): Promise<Podcast> {
    return this.fetch(`/podcasts/${podcastId}`)
  }

  async getPodcastStats(podcastId: string): Promise<PodcastStats> {
    return this.fetch(`/podcasts/${podcastId}/stats`)
  }

  async getPodcastEpisodes(podcastId: string): Promise<Episode[]> {
    return this.fetch(`/podcasts/${podcastId}/episodes`)
  }

  async getEpisode(podcastId: string, episodeGuid: string): Promise<Episode> {
    return this.fetch(`/podcasts/${podcastId}/episodes/${encodeURIComponent(episodeGuid)}`)
  }

  async getEpisodeArtifacts(podcastId: string, episodeId: string): Promise<ProcessingArtifact> {
    return this.fetch(`/artifacts/${podcastId}/${encodeURIComponent(episodeId)}`)
  }

  async processPodcast(podcastId: string): Promise<{ success: boolean, message: string }> {
    const response = await fetch(`${API_BASE}/process/${podcastId}`, { method: 'POST' })
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`)
    }
    return response.json()
  }

  async processAll(): Promise<{ success: boolean, message: string }> {
    const response = await fetch(`${API_BASE}/process`, { method: 'POST' })
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`)
    }
    return response.json()
  }
}

export const api = new APIClient()