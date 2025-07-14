import Parser from 'rss-parser';
import { DatabaseService } from './database';
import { UpstreamEpisode } from '@podcastoor/shared';

export class UpstreamImporter {
  private parser = new Parser();
  
  constructor(private db: DatabaseService) {}
  
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
        
        await this.db.insertUpstreamEpisode(episode);
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