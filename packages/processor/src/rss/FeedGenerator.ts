import { XMLBuilder } from 'fast-xml-parser';
import { ProcessedEpisode, Chapter } from '@podcastoor/shared';
import { FeedMetadata } from './RSSProcessor';

export class FeedGenerator {
  private builder: XMLBuilder;

  constructor() {
    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      indentBy: '  ',
      attributeNamePrefix: '@_',
      textNodeName: '#text'
    });
  }

  async createRSSFeed(episodes: ProcessedEpisode[], metadata: FeedMetadata): Promise<string> {
    const channelData = {
      title: metadata.title,
      description: metadata.description,
      link: metadata.link,
      language: metadata.language,
      lastBuildDate: metadata.lastBuildDate.toUTCString(),
      generator: 'Podcastoor v1.0',
      docs: 'https://cyber.harvard.edu/rss/rss.html',
      copyright: metadata.copyright,
      managingEditor: metadata.author,
      webMaster: metadata.author,
      'itunes:author': metadata.author,
      'itunes:subtitle': this.truncateText(metadata.description, 255),
      'itunes:summary': metadata.description,
      'itunes:owner': {
        'itunes:name': metadata.author,
        'itunes:email': 'podcast@example.com'
      },
      'itunes:image': metadata.image ? { '@_href': metadata.image.url } : undefined,
      'itunes:category': metadata.categories.map(cat => ({ '@_text': cat })),
      'itunes:explicit': 'false',
      'itunes:type': 'episodic',
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
        '@_xmlns:atom': 'http://www.w3.org/2005/Atom',
        channel: channelData
      }
    };

    return this.builder.build(rssData);
  }

  private buildEpisodeItem(episode: ProcessedEpisode): any {
    const item: any = {
      title: episode.title,
      description: this.escapeHtml(episode.enhancedDescription),
      'content:encoded': `<![CDATA[${this.formatContentEncoded(episode)}]]>`,
      link: episode.processedAudioUrl,
      guid: {
        '#text': episode.guid,
        '@_isPermaLink': 'false'
      },
      pubDate: episode.publishDate.toUTCString(),
      enclosure: {
        '@_url': episode.processedAudioUrl,
        '@_type': 'audio/mpeg',
        '@_length': '0' // Would need file size, but not critical
      },
      'itunes:title': episode.title,
      'itunes:subtitle': this.truncateText(episode.description, 255),
      'itunes:summary': episode.enhancedDescription,
      'itunes:duration': this.formatDuration(episode.duration),
      'itunes:explicit': 'false',
      'itunes:episodeType': 'full'
    };

    // Add chapter information
    this.addChapterTags(item, episode);

    return item;
  }

  private addChapterTags(item: any, episode: ProcessedEpisode): void {
    if (episode.chapters.length === 0) return;

    // Add podcast namespace chapters
    const chaptersData = {
      version: '1.2.0',
      chapters: episode.chapters.map(ch => ({
        startTime: ch.startTime,
        title: ch.title,
        img: undefined,
        url: undefined,
        toc: true,
        endTime: ch.endTime
      }))
    };

    item['podcast:chapters'] = {
      '@_url': `data:application/json+chapters,${encodeURIComponent(JSON.stringify(chaptersData))}`
    };

    // Also add simple chapter markers in description for older players
    const chapterMarkers = episode.chapters.map(ch => 
      `${this.formatTime(ch.startTime)} - ${ch.title}`
    ).join('\n');

    item['podcast:transcript'] = {
      '@_url': `data:text/plain,${encodeURIComponent(chapterMarkers)}`,
      '@_type': 'text/plain'
    };
  }

  private formatContentEncoded(episode: ProcessedEpisode): string {
    let content = `<p>${episode.enhancedDescription}</p>`;

    if (episode.chapters.length > 0) {
      content += '<h3>Chapters</h3><ul>';
      episode.chapters.forEach(chapter => {
        content += `<li><strong>${this.formatTime(chapter.startTime)}</strong> - ${this.escapeHtml(chapter.title)}`;
        if (chapter.description) {
          content += `<br/><em>${this.escapeHtml(chapter.description)}</em>`;
        }
        content += '</li>';
      });
      content += '</ul>';
    }

    if (episode.adsRemoved.length > 0) {
      const totalAdTime = episode.adsRemoved.reduce((sum, ad) => sum + (ad.endTime - ad.startTime), 0);
      content += `<p><em>✂️ ${episode.adsRemoved.length} advertisement(s) removed (${this.formatDuration(totalAdTime)}).</em></p>`;
    }

    content += '<p><small>🤖 Enhanced with <a href="https://podcastoor.com">Podcastoor</a></small></p>';

    return content;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
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
    return this.formatTime(seconds);
  }
}