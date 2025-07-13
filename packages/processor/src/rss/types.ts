export interface RSSConfig {
  userAgent: string;
  timeout: number;
  maxRedirects: number;
  validateSSL: boolean;
}

export interface FeedAnalytics {
  totalEpisodes: number;
  processedEpisodes: number;
  totalAdsRemoved: number;
  totalAdTimeRemoved: number;
  averageChaptersPerEpisode: number;
  lastProcessed: Date;
}

export interface EpisodeMetadata {
  title: string;
  description: string;
  duration: number;
  publishDate: Date;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeType?: 'full' | 'trailer' | 'bonus';
  explicit?: boolean;
}