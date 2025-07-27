import Parser from 'rss-parser';
import { Database } from '../database/Database';
import { UpstreamEpisode } from '@podcastoor/shared';

export class UpstreamImporter {
  private parser = new Parser();
  
  constructor(private db: Database) {}
  
  async importPodcastFeed(podcastId: string, feedUrl: string): Promise<number> {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      let imported = 0;
      
      for (const item of feed.items) {
        if (!item.guid || !item.enclosure?.url) continue;
        
        const episode: Omit<UpstreamEpisode, 'id' | 'importedAt'> = {
          podcastId,
          episodeGuid: item.guid,
          title: item.title || 'Untitled',
          description: item.content || item.contentSnippet || '',
          audioUrl: item.enclosure.url,
          publishDate: new Date(item.pubDate || new Date()),
          duration: this.parseDuration(String(item.itunes?.duration || '0')),
          fileSize: parseInt(String(item.enclosure.length || '0'))
        };
        
        // First ensure the show exists
        if (!this.db.getShow(podcastId)) {
          // Get show title from feed
          const showTitle = feed.title || 'Unknown Podcast';
          const showDescription = feed.description || undefined;
          this.db.upsertShow(podcastId, showTitle, showDescription, feedUrl);
        }
        
        // Insert episode
        this.db.upsertEpisode({
          guid: episode.episodeGuid,
          showId: episode.podcastId,
          title: episode.title,
          description: episode.description,
          audioUrl: episode.audioUrl,
          publishDate: episode.publishDate,
          duration: episode.duration
        });
        imported++;
      }
      
      console.log(`Imported ${imported} episodes for podcast ${podcastId}`);
      return imported;
    } catch (error) {
      console.error(`Failed to import podcast ${podcastId}:`, error);
      throw error;
    }
  }
  
  private parseDuration(duration?: string): number {
    if (!duration) return 0;
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parseInt(duration) || 0;
  }
}