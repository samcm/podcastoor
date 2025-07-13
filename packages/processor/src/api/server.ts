import { Hono, Context } from 'hono';
import { logger } from 'hono/logger';
import { PodcastProcessor } from '../PodcastProcessor';

export function createAPIServer(processor: PodcastProcessor) {
  const app = new Hono();

  app.use('*', logger());

  // Health check
  app.get('/health', async (c: Context) => {
    try {
      const stats = await processor.getProcessingStats();
      return c.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats
      });
    } catch (error) {
      return c.json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 503);
    }
  });

  // Process specific podcast
  app.post('/api/process/:podcastId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      await processor.processPodcast(podcastId);
      return c.json({ success: true, message: `Processing initiated for ${podcastId}` });
    } catch (error) {
      return c.json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Process all podcasts
  app.post('/api/process', async (c: Context) => {
    try {
      await processor.processAllPodcasts();
      return c.json({ success: true, message: 'Processing initiated for all podcasts' });
    } catch (error) {
      return c.json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get processing statistics
  app.get('/api/stats', async (c: Context) => {
    try {
      const stats = await processor.getProcessingStats();
      return c.json(stats);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Cleanup old files
  app.post('/api/cleanup', async (c: Context) => {
    try {
      await processor.cleanupOldFiles();
      return c.json({ success: true, message: 'Cleanup initiated' });
    } catch (error) {
      return c.json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get processing artifacts for a specific episode
  app.get('/api/artifacts/:podcastId/:episodeId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    const episodeId = c.req.param('episodeId');
    
    try {
      const storageManager = processor.getStorageManager();
      const artifacts = await storageManager.getProcessingArtifacts(podcastId, episodeId);
      
      if (!artifacts) {
        return c.json({ 
          error: 'Artifacts not found' 
        }, 404);
      }
      
      return c.json(artifacts);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get URL to download processing artifacts
  app.get('/api/artifacts/:podcastId/:episodeId/url', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    const episodeId = c.req.param('episodeId');
    
    try {
      const storageManager = processor.getStorageManager();
      const url = await storageManager.getProcessingArtifactsUrl(podcastId, episodeId);
      
      return c.json({ url });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // List all artifacts for a podcast
  app.get('/api/artifacts/:podcastId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      const storageManager = processor.getStorageManager();
      const artifactsList = await storageManager.listAudioFiles(`artifacts/${podcastId}/`);
      
      // Extract episode IDs from the artifact keys
      const episodes = artifactsList
        .filter(obj => obj.key.endsWith('/processing-data.json'))
        .map(obj => {
          const parts = obj.key.split('/');
          return {
            episodeId: parts[2],
            size: obj.size,
            lastModified: obj.lastModified,
            url: obj.url
          };
        });
      
      return c.json({ 
        podcastId,
        episodes 
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // RSS Feed Endpoints
  
  // Serve RSS feed directly
  app.get('/rss/:podcastId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      const storageManager = processor.getStorageManager();
      const rssFeedUrl = await storageManager.getRSSFeedUrl(podcastId);
      
      // Fetch the RSS content and serve it with proper content type
      const response = await fetch(rssFeedUrl);
      if (!response.ok) {
        return c.text('RSS feed not found', 404);
      }
      
      const rssContent = await response.text();
      c.header('Content-Type', 'application/rss+xml; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      return c.text(rssContent);
    } catch (error) {
      console.error(`Failed to serve RSS feed for ${podcastId}:`, error);
      return c.text('RSS feed not found', 404);
    }
  });
  
  // Redirect from original RSS URL pattern to processed
  app.get('/feed/:podcastId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    return c.redirect(`/rss/${podcastId}`, 301);
  });
  
  // List all available podcasts
  app.get('/api/podcasts', async (c: Context) => {
    try {
      const db = processor.getDatabaseManager();
      const podcasts = db.getAllPodcasts();
      
      // Add RSS feed URLs to each podcast
      const podcastsWithFeeds = podcasts.map(podcast => ({
        ...podcast,
        rssFeedUrl: `${c.req.url.split('/api')[0]}/rss/${podcast.id}`,
        alternateUrl: `${c.req.url.split('/api')[0]}/feed/${podcast.id}`
      }));
      
      return c.json({
        podcasts: podcastsWithFeeds,
        totalCount: podcastsWithFeeds.length
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Get specific podcast info with RSS URL
  app.get('/api/podcasts/:podcastId', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      const db = processor.getDatabaseManager();
      const podcast = db.getPodcast(podcastId);
      
      if (!podcast) {
        return c.json({ error: 'Podcast not found' }, 404);
      }
      
      const episodes = db.getEpisodesByPodcast(podcastId);
      const processedCount = episodes.filter(ep => ep.processedUrl).length;
      
      return c.json({
        ...podcast,
        rssFeedUrl: `${c.req.url.split('/api')[0]}/rss/${podcast.id}`,
        alternateUrl: `${c.req.url.split('/api')[0]}/feed/${podcast.id}`,
        episodeCount: episodes.length,
        processedEpisodeCount: processedCount,
        processingProgress: episodes.length > 0 ? (processedCount / episodes.length) * 100 : 0
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Simple landing page
  app.get('/', async (c: Context) => {
    try {
      const db = processor.getDatabaseManager();
      const podcasts = db.getAllPodcasts();
      const baseUrl = c.req.url.replace(/\/$/, '');
      
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Podcastoor - Ad-Free Podcast RSS Feeds</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #666;
      margin-bottom: 2rem;
    }
    .podcast {
      padding: 1rem;
      border: 1px solid #eee;
      border-radius: 4px;
      margin-bottom: 1rem;
    }
    .podcast h3 {
      margin: 0 0 0.5rem 0;
      color: #333;
    }
    .podcast-info {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
    }
    .feed-url {
      background: #f0f0f0;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.85rem;
      word-break: break-all;
      margin: 0.5rem 0;
    }
    .copy-button {
      background: #007bff;
      color: white;
      border: none;
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .copy-button:hover {
      background: #0056b3;
    }
    .stats {
      background: #f8f9fa;
      padding: 1rem;
      border-radius: 4px;
      margin-bottom: 2rem;
    }
    .no-podcasts {
      text-align: center;
      color: #666;
      padding: 2rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎙️ Podcastoor</h1>
    <p class="subtitle">Self-hosted ad-free podcast RSS feeds with AI-powered enhancements</p>
    
    <div class="stats">
      <strong>${podcasts.length}</strong> podcast${podcasts.length !== 1 ? 's' : ''} available
    </div>
    
    ${podcasts.length === 0 ? 
      '<div class="no-podcasts">No podcasts added yet. Use the API to add podcasts.</div>' :
      podcasts.map(podcast => {
        const episodes = db.getEpisodesByPodcast(podcast.id);
        const processedCount = episodes.filter(ep => ep.processedUrl).length;
        return `
          <div class="podcast">
            <h3>${podcast.title}</h3>
            <div class="podcast-info">
              ${processedCount}/${episodes.length} episodes processed
            </div>
            <div class="feed-url">
              ${baseUrl}/rss/${podcast.id}
              <button class="copy-button" onclick="navigator.clipboard.writeText('${baseUrl}/rss/${podcast.id}')">
                Copy
              </button>
            </div>
          </div>
        `;
      }).join('')
    }
    
    <hr style="margin: 2rem 0; border: none; border-top: 1px solid #eee;">
    
    <h3>API Endpoints</h3>
    <ul>
      <li><code>GET /api/podcasts</code> - List all podcasts</li>
      <li><code>GET /api/podcasts/:id</code> - Get podcast details</li>
      <li><code>GET /rss/:id</code> - Get processed RSS feed</li>
      <li><code>POST /api/process</code> - Process a new podcast</li>
      <li><code>GET /api/stats</code> - Get processing statistics</li>
    </ul>
  </div>
</body>
</html>
      `;
      
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.html(html);
    } catch (error) {
      return c.text('Error loading podcasts', 500);
    }
  });
  
  return app;
}