import { Hono, Context } from 'hono';
import { logger } from 'hono/logger';
import { PodcastProcessor } from '../PodcastProcessor.js';

export function createAPIServer(processor: PodcastProcessor) {
  const app = new Hono();

  app.use('*', logger());

  // Health check
  app.get('/health', async (c: Context) => {
    const stats = await processor.getProcessingStats();
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      stats
    });
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
    const stats = await processor.getProcessingStats();
    return c.json(stats);
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

  return app;
}