import { Context } from 'hono';
import { Env } from '../index.js';

export async function rssHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const podcastId = c.req.param('podcastId');
  
  if (!podcastId) {
    return c.text('Missing podcast ID', 400);
  }

  console.log(`RSS request for podcast: ${podcastId}`);

  try {
    // Try to get from cache first
    const cacheKey = `rss:${podcastId}`;
    const cachedFeed = await c.env.RSS_CACHE.get(cacheKey);
    
    if (cachedFeed) {
      console.log(`Cache hit for podcast: ${podcastId}`);
      return new Response(cachedFeed, {
        headers: {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': `public, max-age=${c.env.CACHE_TTL || '300'}`,
          'X-Cache': 'HIT'
        }
      });
    }

    console.log(`Cache miss for podcast: ${podcastId}`);

    // Fetch from processor
    const processedFeed = await fetchProcessedFeed(c.env.PROCESSOR_URL, podcastId);
    
    if (!processedFeed) {
      return c.text('Podcast not found', 404);
    }

    // Cache the feed
    const cacheTTL = parseInt(c.env.CACHE_TTL || '300', 10);
    await c.env.RSS_CACHE.put(cacheKey, processedFeed, {
      expirationTtl: cacheTTL
    });

    console.log(`Cached RSS feed for podcast: ${podcastId}`);

    return new Response(processedFeed, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': `public, max-age=${cacheTTL}`,
        'X-Cache': 'MISS'
      }
    });

  } catch (error) {
    console.error(`RSS handler error for podcast ${podcastId}:`, error);
    return c.text('Failed to fetch RSS feed', 500);
  }
}

async function fetchProcessedFeed(processorUrl: string, podcastId: string): Promise<string | null> {
  try {
    const url = `${processorUrl}/api/rss/${podcastId}`;
    console.log(`Fetching processed feed from: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Podcastoor-Worker/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      cf: {
        cacheTtl: 60, // Cache at Cloudflare edge for 1 minute
        cacheEverything: true
      }
    });

    if (!response.ok) {
      console.error(`Processor responded with status: ${response.status}`);
      return null;
    }

    const feed = await response.text();
    console.log(`Fetched feed (${feed.length} bytes)`);
    
    return feed;
  } catch (error) {
    console.error('Failed to fetch processed feed:', error);
    return null;
  }
}