import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';
import { PodcastProcessor } from '../PodcastProcessor';

export function createAPIServer(processor: PodcastProcessor) {
  const app = new Hono();

  // Enable CORS for development
  if (process.env.NODE_ENV === 'development') {
    app.use('*', cors({
      origin: 'http://localhost:5173',
      credentials: true,
    }));
  }

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

  // Get recently processed episodes
  app.get('/api/episodes/recent', async (c: Context) => {
    try {
      const db = processor.getDatabaseManager();
      const recent = await db.getRecentlyProcessedEpisodes(20);
      
      return c.json({
        episodes: recent,
        count: recent.length
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // New manual job endpoints for refactored schema (temporarily disabled until integration is complete)
  /*
  app.post('/api/jobs', async (c: Context) => {
    // Implementation will be added after PodcastProcessor integration
    return c.json({ error: 'Manual job creation not yet available' }, 503);
  });
  
  app.get('/api/episodes/:episodeGuid', async (c: Context) => {
    // Implementation will be added after PodcastProcessor integration
    return c.json({ error: 'Episode lookup by GUID not yet available' }, 503);
  });
  
  app.get('/audio/:episodeGuid', async (c: Context) => {
    // Implementation will be added after PodcastProcessor integration
    return c.json({ error: 'Audio proxy not yet available' }, 503);
  });
  */
  
  // Get episodes for a specific podcast
  app.get('/api/podcasts/:podcastId/episodes', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      const db = processor.getDatabaseManager();
      const episodes = await db.getEpisodesByPodcast(podcastId);
      
      return c.json(episodes);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Get specific episode details
  app.get('/api/podcasts/:podcastId/episodes/:episodeGuid', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    const episodeGuid = c.req.param('episodeGuid');
    
    try {
      const db = processor.getDatabaseManager();
      const episode = await db.getEpisodeByGuid(podcastId, episodeGuid);
      
      if (!episode) {
        return c.json({ error: 'Episode not found' }, 404);
      }
      
      // Build the EpisodeDetails response in the expected format
      const response: any = {
        upstream: {
          id: episode.id,
          podcastId: episode.podcastId,
          episodeGuid: episode.episodeGuid,
          title: episode.title,
          description: episode.description,
          audioUrl: episode.audioUrl,
          publishDate: episode.publishDate,
          duration: episode.duration,
          fileSize: episode.fileSize || 0,
          importedAt: episode.createdAt
        },
        chapters: [],
        adRemovals: [],
        llmCosts: []
      };
      
      // Get processing result if available
      if (episode.status === 'completed' && episode.processedUrl) {
        const results = await db.getProcessingResults(podcastId);
        const result = results.find(r => r.episodeId === episodeGuid);
        if (result) {
          response.result = {
            ...result,
            processedUrl: episode.processedUrl,
            processingCost: episode.processingCost
          };
          response.chapters = result.chapters || [];
          response.adRemovals = result.adsRemoved || [];
          
          // Get ad segments from artifacts
          try {
            const storageManager = processor.getStorageManager();
            const artifacts = await storageManager.getProcessingArtifacts(podcastId, episodeGuid);
            if (artifacts && artifacts.adSegments) {
              response.adSegments = artifacts.adSegments;
            }
          } catch (error) {
            console.error('Failed to get ad segments from artifacts:', error);
          }
        }
      }
      
      return c.json(response);
    } catch (error) {
      console.error('Error fetching episode details:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Get podcast stats
  app.get('/api/podcasts/:podcastId/stats', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    
    try {
      const db = processor.getDatabaseManager();
      const stats = await db.getPodcastStats(podcastId);
      
      return c.json(stats);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Ad segment endpoint
  app.get('/api/ads/:podcastId/:episodeGuid/:adIndex', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    const episodeGuid = c.req.param('episodeGuid');
    const adIndex = parseInt(c.req.param('adIndex'), 10);
    
    try {
      const storageManager = processor.getStorageManager();
      const artifacts = await storageManager.getProcessingArtifacts(podcastId, episodeGuid);
      
      if (!artifacts || !artifacts.adSegments) {
        return c.json({ error: 'Ad segments not found' }, 404);
      }
      
      const adSegment = artifacts.adSegments[adIndex - 1];
      if (!adSegment) {
        return c.json({ error: 'Ad segment not found' }, 404);
      }
      
      // Return a redirect to the actual ad audio URL
      return c.redirect(adSegment.audioUrl, 302);
    } catch (error) {
      console.error(`Failed to serve ad segment for ${podcastId}/${episodeGuid}/${adIndex}:`, error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });
  
  // Get all ad segments for an episode
  app.get('/api/ads/:podcastId/:episodeGuid', async (c: Context) => {
    const podcastId = c.req.param('podcastId');
    const episodeGuid = c.req.param('episodeGuid');
    
    try {
      const storageManager = processor.getStorageManager();
      const artifacts = await storageManager.getProcessingArtifacts(podcastId, episodeGuid);
      
      if (!artifacts || !artifacts.adSegments) {
        return c.json({ adSegments: [] });
      }
      
      return c.json({ 
        adSegments: artifacts.adSegments,
        count: artifacts.adSegments.length 
      });
    } catch (error) {
      console.error(`Failed to get ad segments for ${podcastId}/${episodeGuid}:`, error);
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
      const rssContent = await storageManager.getRSSFeedContent(podcastId);
      
      if (!rssContent) {
        return c.text('RSS feed not found', 404);
      }
      
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
      
      const episodes = await db.getEpisodesByPodcast(podcastId);
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
  
  // Serve static files for the web UI
  const staticPath = '/app/packages/web/dist';
  
  if (existsSync(staticPath)) {
    console.log(`Serving static files from: ${staticPath}`);
    
    // Serve assets
    app.get('/assets/*', async (c) => {
      const path = c.req.path.replace('/assets/', '');
      const filePath = join(staticPath, 'assets', path);
      
      if (existsSync(filePath)) {
        const { readFileSync } = await import('fs');
        const content = readFileSync(filePath);
        
        if (path.endsWith('.css')) {
          c.header('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
          c.header('Content-Type', 'application/javascript');
        }
        
        return c.body(content);
      }
      return c.notFound();
    });
    
    // Serve index.html for all non-API routes
    app.get('*', async (c) => {
      const indexPath = join(staticPath, 'index.html');
      if (existsSync(indexPath)) {
        const { readFileSync } = await import('fs');
        const html = readFileSync(indexPath, 'utf-8');
        return c.html(html);
      }
      return c.text('Web UI not found', 404);
    });
  }
  
  return app;
}