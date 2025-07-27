import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';
import { PodcastProcessor } from '../PodcastProcessor';

// Helper functions for RSS feed generation
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTimeForPSC(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

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
      const health = processor.getHealthStatus();
      return c.json({
        timestamp: new Date().toISOString(),
        ...health
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
      return c.json({ success: true, message: `Started processing podcast ${podcastId}` });
    } catch (error) {
      return c.json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Process all podcasts
  app.post('/api/process-all', async (c: Context) => {
    try {
      await processor.processAllPodcasts();
      return c.json({ success: true, message: 'Started processing all podcasts' });
    } catch (error) {
      return c.json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get all shows
  app.get('/api/shows', async (c: Context) => {
    try {
      const db = processor.getDatabase();
      const shows = db.getAllShows();
      
      // Add stats for each show
      const showsWithStats = shows.map(show => {
        const stats = db.getShowStats(show.id);
        return {
          ...show,
          episodeCount: stats.episodeCount,
          processedCount: stats.processedCount
        };
      });
      
      return c.json(showsWithStats);
    } catch (error) {
      console.error('Error fetching shows:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get specific show
  app.get('/api/shows/:showId', async (c: Context) => {
    const showId = c.req.param('showId');
    
    try {
      const db = processor.getDatabase();
      const show = db.getShow(showId);
      
      if (!show) {
        return c.json({ error: 'Show not found' }, 404);
      }
      
      return c.json(show);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get show stats
  app.get('/api/shows/:showId/stats', async (c: Context) => {
    const showId = c.req.param('showId');
    
    try {
      const db = processor.getDatabase();
      const stats = db.getShowStats(showId);
      return c.json(stats);
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get show episodes
  app.get('/api/shows/:showId/episodes', async (c: Context) => {
    const showId = c.req.param('showId');
    
    try {
      const db = processor.getDatabase();
      const episodes = db.getShowEpisodes(showId);
      
      // Add job status to each episode
      const episodesWithStatus = episodes.map(episode => {
        const jobs = db.getEpisodeJobs(episode.guid);
        // Find the most recent completed job, or fall back to the most recent job
        const relevantJob = jobs.find(job => job.status === 'completed') || jobs[0];
        
        return {
          ...episode,
          hasJob: jobs.length > 0,
          jobStatus: relevantJob?.status,
          processedAt: relevantJob?.completedAt
        };
      });
      
      return c.json(episodesWithStatus);
    } catch (error) {
      console.error('Error fetching episodes:', error);
      return c.json([], 500);
    }
  });

  // Get recent episodes - MUST be before dynamic :episodeGuid route
  app.get('/api/episodes/recent', async (c: Context) => {
    try {
      const db = processor.getDatabase();
      const episodes = db.getRecentEpisodes(20);
      
      // Add show info and job status
      const enrichedEpisodes = episodes.map(episode => {
        const show = db.getShow(episode.showId);
        const jobs = db.getEpisodeJobs(episode.guid);
        // Find the most recent completed job, or fall back to the most recent job
        const relevantJob = jobs.find(job => job.status === 'completed') || jobs[0];
        
        return {
          ...episode,
          showTitle: show?.title,
          hasJob: jobs.length > 0,
          jobStatus: relevantJob?.status,
          processedAt: relevantJob?.completedAt
        };
      });
      
      return c.json({
        episodes: enrichedEpisodes,
        count: enrichedEpisodes.length
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get episode details
  app.get('/api/episodes/:episodeGuid', async (c: Context) => {
    const episodeGuid = c.req.param('episodeGuid');
    
    try {
      const db = processor.getDatabase();
      const details = db.getEpisodeDetails(episodeGuid);
      
      if (!details || !details.episode) {
        return c.json({ error: 'Episode not found' }, 404);
      }
      
      return c.json(details);
    } catch (error) {
      console.error('Error fetching episode details:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Create processing job
  app.post('/api/jobs', async (c: Context) => {
    try {
      const body = await c.req.json();
      const { episodeGuid, priority = 5 } = body;
      
      if (!episodeGuid) {
        return c.json({ error: 'episodeGuid is required' }, 400);
      }
      
      const db = processor.getDatabase();
      const episode = db.getEpisode(episodeGuid);
      
      if (!episode) {
        return c.json({ error: 'Episode not found' }, 404);
      }
      
      const jobId = db.createJob(episodeGuid, priority);
      
      return c.json({ 
        success: true, 
        jobId,
        message: `Created job ${jobId} for episode ${episodeGuid}`
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // Get job stats
  app.get('/api/jobs/stats', async (c: Context) => {
    try {
      const jobManager = processor.getJobManager();
      return c.json(jobManager.getStats());
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });


  // Serve processed audio files
  app.get('/audio/:episodeGuid', async (c: Context) => {
    const episodeGuid = c.req.param('episodeGuid');
    
    try {
      const db = processor.getDatabase();
      const details = db.getEpisodeDetails(episodeGuid);
      
      // Redirect to processed URL if available, otherwise original
      if (details?.processedEpisode) {
        return c.redirect(details.processedEpisode.processedUrl);
      } else if (details?.episode) {
        return c.redirect(details.episode.audioUrl);
      } else {
        return c.json({ error: 'Episode not found' }, 404);
      }
    } catch (error) {
      console.error('Error serving audio:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });

  // RSS feed proxy - serves processed audio URLs
  app.get('/rss/:showId', async (c: Context) => {
    const showIdWithExt = c.req.param('showId');
    // Remove .rss extension if present
    const showId = showIdWithExt.endsWith('.rss') 
      ? showIdWithExt.slice(0, -4) 
      : showIdWithExt;
    
    try {
      const db = processor.getDatabase();
      console.log('RSS request for show:', showId);
      const show = db.getShow(showId);
      console.log('Found show:', show);
      
      if (!show) {
        return c.json({ error: 'Show not found' }, 404);
      }
      
      // Fetch the original RSS feed
      const response = await fetch(show.feedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch RSS feed: ${response.statusText}`);
      }
      
      let rssContent = await response.text();
      
      // Get the public URL from config
      const publicUrl = processor.getConfig().getPublicUrl();
      
      // Get all episodes with processed versions
      const episodes = db.getShowEpisodes(showId);
      
      // Replace all audio URLs to go through our proxy
      for (const episode of episodes) {
        // Always use our audio proxy endpoint
        const audioProxyUrl = `${publicUrl}/audio/${episode.guid}`;
        
        // Find all items with this GUID and replace their audio URLs
        const guidPattern = episode.guid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Create a pattern to find the item block for this episode
        const itemPattern = new RegExp(
          `<item>(?:[\\s\\S]*?)<guid[^>]*>${guidPattern}</guid>(?:[\\s\\S]*?)</item>`,
          'g'
        );
        
        rssContent = rssContent.replace(itemPattern, (itemBlock) => {
          // Replace audio URL in enclosure tag
          itemBlock = itemBlock.replace(
            /(<enclosure[^>]*url=["'])([^"']+)([^>]*>)/g,
            `$1${audioProxyUrl}$3`
          );
          
          // Replace audio URL in media:content tag
          itemBlock = itemBlock.replace(
            /(<media:content[^>]*url=["'])([^"']+)([^>]*type="audio)/g,
            `$1${audioProxyUrl}$3`
          );
          
          return itemBlock;
        });
      }
      
      // Now handle additional modifications for processed episodes
      for (const episode of episodes) {
        const jobs = db.getEpisodeJobs(episode.guid);
        const completedJob = jobs.find(job => job.status === 'completed');
        
        if (completedJob) {
          const processedEpisode = db.getProcessedEpisode(completedJob.id);
          const chapters = db.getChapters(completedJob.id);
          const ads = db.getAds(completedJob.id);
          
          if (processedEpisode) {
            // Find all items with this GUID to make additional modifications
            const guidPattern = episode.guid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Create a pattern to find the item block for this episode
            const itemPattern = new RegExp(
              `<item>(?:[\\s\\S]*?)<guid[^>]*>${guidPattern}</guid>(?:[\\s\\S]*?)</item>`,
              'g'
            );
            
            rssContent = rssContent.replace(itemPattern, (itemBlock) => {
              // Update duration
              if (processedEpisode.processedDuration) {
                itemBlock = itemBlock.replace(
                  /<itunes:duration>[^<]*<\/itunes:duration>/g,
                  `<itunes:duration>${Math.round(processedEpisode.processedDuration)}</itunes:duration>`
                );
              }
              
              // Update file size in enclosure tag
              const fileSizeInBytes = Math.round(processedEpisode.processedDuration * 128 * 1024 / 8); // Estimate based on 128kbps
              itemBlock = itemBlock.replace(
                /(<enclosure[^>]*length=["'])([^"']+)([^>]*>)/g,
                `$1${fileSizeInBytes}$3`
              );
              
              // Add ad removal stats to title if ads were removed
              if (ads && ads.length > 0) {
                const timeSaved = processedEpisode.originalDuration - processedEpisode.processedDuration;
                const minutes = Math.floor(timeSaved / 60);
                const seconds = Math.round(timeSaved % 60);
                const timeString = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `0:${seconds}`;
                const adStats = ` (${ads.length} ads removed, ${timeString} saved)`;
                
                itemBlock = itemBlock.replace(
                  /(<title>)([^<]*)(<\/title>)/,
                  `$1$2${adStats}$3`
                );
              }
              
              // Add note to description
              if (ads && ads.length > 0) {
                const timeSaved = processedEpisode.originalDuration - processedEpisode.processedDuration;
                const minutes = Math.floor(timeSaved / 60);
                const seconds = Math.round(timeSaved % 60);
                const timeString = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `0:${seconds}`;
                const adNote = `<p><strong>Ad-Free Version</strong> - ${ads.length} ads removed, ${timeString} saved.</p>`;
                
                itemBlock = itemBlock.replace(
                  /(<description><!\[CDATA\[)([^\]]*)/,
                  `$1${adNote}$2`
                );
              }
              
              // Add chapters if we have them
              if (chapters && chapters.length > 0) {
                // Add Podcast 2.0 chapters
                const chaptersXml = chapters.map(ch => 
                  `<podcast:chapter start="${ch.startTime}" title="${escapeXml(ch.title)}"${ch.description ? ` description="${escapeXml(ch.description)}"` : ''} />`
                ).join('\n    ');
                
                // Insert chapters before the closing </item> tag
                itemBlock = itemBlock.replace(
                  '</item>',
                  `  <podcast:chapters version="1.2">
    ${chaptersXml}
  </podcast:chapters>
</item>`
                );
                
                // Also add PSC (Podlove Simple Chapters) format for better compatibility
                const pscChapters = chapters.map(ch => {
                  const startTime = formatTimeForPSC(ch.startTime);
                  return `<psc:chapter start="${startTime}" title="${escapeXml(ch.title)}" />`;
                }).join('\n    ');
                
                itemBlock = itemBlock.replace(
                  '</item>',
                  `  <psc:chapters version="1.2">
    ${pscChapters}
  </psc:chapters>
</item>`
                );
              }
              
              return itemBlock;
            });
          }
        }
      }
      
      // Set appropriate headers
      c.header('Content-Type', 'application/rss+xml; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      
      return c.body(rssContent);
      
    } catch (error) {
      console.error('Error serving RSS feed:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 500);
    }
  });


  // Serve static files from storage
  if (process.env.NODE_ENV === 'development') {
    const storagePath = join(process.cwd(), 'data', 'storage');
    console.log('Serving static files from:', storagePath);
    if (existsSync(storagePath)) {
      app.use('/files/*', serveStatic({ 
        root: storagePath,
        rewriteRequestPath: (path) => path.replace(/^\/files/, '')
      }));
    } else {
      console.warn('Storage path does not exist:', storagePath);
    }
  }

  return app;
}