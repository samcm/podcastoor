import Parser from 'rss-parser';
import { XMLBuilder } from 'fast-xml-parser';
import { ProcessingResult, Chapter, AdDetection, Episode, ProcessedEpisode } from '@podcastoor/shared';

export interface ParsedFeed {
  title: string;
  description: string;
  link: string;
  language?: string;
  copyright?: string;
  author?: string;
  image?: {
    url: string;
    title?: string;
    link?: string;
  };
  categories?: string[];
  episodes: Episode[];
}

export interface FeedMetadata {
  title: string;
  description: string;
  link: string;
  language: string;
  copyright?: string;
  author?: string;
  image?: {
    url: string;
    title?: string;
    link?: string;
  };
  categories: string[];
  lastBuildDate: Date;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class RSSProcessor {
  private parser: Parser;
  private builder: XMLBuilder;

  constructor() {
    this.parser = new Parser({
      customFields: {
        item: [
          'itunes:duration',
          'itunes:episode',
          'itunes:season',
          'itunes:episodeType',
          'itunes:image',
          'content:encoded'
        ],
        feed: [
          'itunes:author',
          'itunes:category',
          'itunes:image',
          'itunes:explicit',
          'itunes:type'
        ]
      }
    });

    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      indentBy: '  ',
      attributeNamePrefix: '@_',
      textNodeName: '#text'
    });
  }

  async fetchFeed(url: string): Promise<ParsedFeed> {
    console.log(`Fetching RSS feed: ${url}`);
    
    try {
      const feed = await this.parser.parseURL(url);
      
      const episodes: Episode[] = feed.items.map((item: any, index: number) => {
        const audioUrl = this.extractAudioUrl(item);
        if (!audioUrl) {
          throw new Error(`No audio URL found for episode: ${item.title}`);
        }

        return {
          guid: item.guid || `${url}-${index}`,
          title: item.title || `Episode ${index + 1}`,
          description: item.description || item.contentSnippet || '',
          audioUrl,
          publishDate: item.pubDate ? new Date(item.pubDate) : new Date(),
          duration: this.parseDuration(item['itunes:duration'] || '0')
        };
      });

      const parsedFeed: ParsedFeed = {
        title: feed.title || 'Unknown Podcast',
        description: feed.description || '',
        link: feed.link || url,
        language: feed.language || 'en',
        copyright: feed.copyright,
        author: feed.author || feed['itunes:author'],
        image: this.extractImage(feed),
        categories: this.extractCategories(feed),
        episodes
      };

      console.log(`Parsed RSS feed: ${parsedFeed.title} (${episodes.length} episodes)`);
      return parsedFeed;
    } catch (error) {
      throw new Error(`Failed to fetch RSS feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async parseEpisodes(feed: ParsedFeed): Promise<Episode[]> {
    return feed.episodes;
  }

  async filterNewEpisodes(episodes: Episode[], lastProcessed: Date): Promise<Episode[]> {
    const newEpisodes = episodes.filter(episode => episode.publishDate > lastProcessed);
    console.log(`Found ${newEpisodes.length} new episodes since ${lastProcessed.toISOString()}`);
    return newEpisodes;
  }

  async generateProcessedFeed(original: ParsedFeed, results: ProcessingResult[]): Promise<string> {
    console.log(`Generating processed RSS feed for ${results.length} episodes`);
    
    try {
      // Create processed episodes map for quick lookup
      const processedMap = new Map<string, ProcessingResult>();
      results.forEach(result => {
        processedMap.set(result.episodeId, result);
      });

      // Transform episodes
      const processedEpisodes: ProcessedEpisode[] = original.episodes.map(episode => {
        const processed = processedMap.get(episode.guid);
        
        if (processed) {
          return {
            ...episode,
            processedAudioUrl: processed.processedUrl,
            chapters: processed.chapters,
            adsRemoved: processed.adsRemoved,
            enhancedDescription: this.enhanceEpisodeDescription(episode, processed)
          };
        }

        // Episode not processed yet, return as-is
        return {
          ...episode,
          processedAudioUrl: episode.audioUrl,
          chapters: [],
          adsRemoved: [],
          enhancedDescription: episode.description
        };
      });

      const feedMetadata: FeedMetadata = {
        title: original.title,
        description: this.enhanceFeedDescription(original.description, results.length),
        link: original.link,
        language: original.language || 'en',
        copyright: original.copyright,
        author: original.author,
        image: original.image,
        categories: original.categories || [],
        lastBuildDate: new Date()
      };

      return this.createRSSFeed(processedEpisodes, feedMetadata);
    } catch (error) {
      throw new Error(`Failed to generate processed feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async validateFeed(feedXml: string): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: []
    };

    try {
      // Basic XML validation
      if (!feedXml.includes('<rss')) {
        result.errors.push('Not a valid RSS feed - missing <rss> element');
        result.isValid = false;
      }

      if (!feedXml.includes('<channel>')) {
        result.errors.push('Missing required <channel> element');
        result.isValid = false;
      }

      // Check for required elements
      const requiredElements = ['<title>', '<description>', '<link>'];
      for (const element of requiredElements) {
        if (!feedXml.includes(element)) {
          result.errors.push(`Missing required element: ${element}`);
          result.isValid = false;
        }
      }

      // Warnings for recommended elements
      const recommendedElements = ['<lastBuildDate>', '<language>'];
      for (const element of recommendedElements) {
        if (!feedXml.includes(element)) {
          result.warnings.push(`Missing recommended element: ${element}`);
        }
      }

      // Check for episodes
      if (!feedXml.includes('<item>')) {
        result.warnings.push('No episodes found in feed');
      }

    } catch (error) {
      result.errors.push(`Validation error: ${error instanceof Error ? error.message : String(error)}`);
      result.isValid = false;
    }

    return result;
  }

  private enhanceEpisodeDescription(episode: Episode, result: ProcessingResult): string {
    let enhanced = episode.description;

    // Add chapter information
    if (result.chapters.length > 0) {
      const chapterList = result.chapters.map(ch => 
        `${this.formatTime(ch.startTime)} - ${ch.title}`
      ).join('\n');
      
      enhanced += `\n\n📑 Chapters:\n${chapterList}`;
    }

    // Add ad removal note
    if (result.adsRemoved.length > 0) {
      const totalAdTime = result.adsRemoved.reduce((sum, ad) => sum + (ad.endTime - ad.startTime), 0);
      enhanced += `\n\n✂️ ${result.adsRemoved.length} advertisement(s) removed (${this.formatDuration(totalAdTime)}).`;
    }

    // Add processing note
    enhanced += `\n\n🤖 Processed with Podcastoor on ${result.processedAt.toLocaleDateString()}.`;

    return enhanced;
  }

  private enhanceFeedDescription(original: string, processedCount: number): string {
    return `${original}\n\n✨ Enhanced with Podcastoor - ${processedCount} episodes processed with automatic ad removal and chapter generation.`;
  }

  private createChapterMarkers(chapters: Chapter[]): string {
    return chapters.map(chapter => 
      `${this.formatTime(chapter.startTime)} ${chapter.title}`
    ).join('\n');
  }

  private createRSSFeed(episodes: ProcessedEpisode[], metadata: FeedMetadata): string {
    const channelData = {
      title: metadata.title,
      description: metadata.description,
      link: metadata.link,
      language: metadata.language,
      lastBuildDate: metadata.lastBuildDate.toUTCString(),
      copyright: metadata.copyright,
      'itunes:author': metadata.author,
      'itunes:image': metadata.image ? { '@_href': metadata.image.url } : undefined,
      'itunes:category': metadata.categories.map(cat => ({ '@_text': cat })),
      item: episodes.map(episode => this.buildEpisodeItem(episode))
    };

    const rssData = {
      '?xml': {
        '@_version': '1.0',
        '@_encoding': 'UTF-8'
      },
      rss: {
        '@_version': '2.0',
        '@_xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd',
        '@_xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
        '@_xmlns:podcast': 'https://podcastindex.org/namespace/1.0',
        channel: channelData
      }
    };

    return this.builder.build(rssData);
  }

  private buildEpisodeItem(episode: ProcessedEpisode): any {
    const item: any = {
      title: episode.title,
      description: episode.enhancedDescription,
      link: episode.processedAudioUrl,
      guid: {
        '#text': episode.guid,
        '@_isPermaLink': 'false'
      },
      pubDate: episode.publishDate.toUTCString(),
      enclosure: {
        '@_url': episode.processedAudioUrl,
        '@_type': 'audio/mpeg'
      },
      'itunes:duration': this.formatDuration(episode.duration)
    };

    // Add chapter information using podcast namespace
    if (episode.chapters.length > 0) {
      item['podcast:chapters'] = {
        '@_url': `data:application/json+chapters,${encodeURIComponent(JSON.stringify({
          version: '1.2.0',
          chapters: episode.chapters.map(ch => ({
            startTime: ch.startTime,
            title: ch.title,
            img: undefined,
            url: undefined
          }))
        }))}`
      };
    }

    return item;
  }

  private extractAudioUrl(item: any): string | null {
    // Try enclosure first (most common)
    if (item.enclosure && item.enclosure.url) {
      return item.enclosure.url;
    }

    // Try content:encoded for embedded audio
    if (item['content:encoded']) {
      const urlMatch = item['content:encoded'].match(/src="([^"]+\.(?:mp3|m4a|ogg|wav))"/i);
      if (urlMatch) {
        return urlMatch[1];
      }
    }

    // Try description for audio links
    if (item.description) {
      const urlMatch = item.description.match(/https?:\/\/[^\s]+\.(?:mp3|m4a|ogg|wav)/i);
      if (urlMatch) {
        return urlMatch[0];
      }
    }

    return null;
  }

  private extractImage(feed: any): { url: string; title?: string; link?: string } | undefined {
    if (feed['itunes:image']) {
      if (typeof feed['itunes:image'] === 'string') {
        return { url: feed['itunes:image'] };
      }
      if (feed['itunes:image'].href) {
        return { url: feed['itunes:image'].href };
      }
    }

    if (feed.image?.url) {
      return {
        url: feed.image.url,
        title: feed.image.title,
        link: feed.image.link
      };
    }

    return undefined;
  }

  private extractCategories(feed: any): string[] {
    const categories: string[] = [];

    if (feed.categories) {
      if (Array.isArray(feed.categories)) {
        categories.push(...feed.categories);
      } else if (typeof feed.categories === 'string') {
        categories.push(feed.categories);
      }
    }

    if (feed['itunes:category']) {
      if (Array.isArray(feed['itunes:category'])) {
        categories.push(...feed['itunes:category'].map((cat: any) => cat.text || cat));
      } else if (typeof feed['itunes:category'] === 'string') {
        categories.push(feed['itunes:category']);
      }
    }

    return [...new Set(categories)]; // Remove duplicates
  }

  private parseDuration(duration: string | number): number {
    if (typeof duration === 'number') {
      return duration;
    }

    if (typeof duration === 'string') {
      // Handle HH:MM:SS format
      const timeParts = duration.split(':').map(part => parseInt(part, 10));
      if (timeParts.length === 3) {
        return timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
      }
      if (timeParts.length === 2) {
        return timeParts[0] * 60 + timeParts[1];
      }
      if (timeParts.length === 1) {
        return timeParts[0];
      }
    }

    return 0;
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}