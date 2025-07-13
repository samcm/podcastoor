import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { rssHandler } from './handlers/rss.js';
import { audioHandler } from './handlers/audio.js';
import { healthHandler } from './handlers/health.js';

export interface Env {
  RSS_CACHE: KVNamespace;
  AUDIO_STORAGE: R2Bucket;
  PROCESSOR_URL: string;
  CACHE_TTL: string;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', timing());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'User-Agent'],
  maxAge: 86400
}));

// Health check
app.get('/health', healthHandler);

// RSS feed endpoint with caching
app.get('/rss/:podcastId', 
  cache({
    cacheName: 'rss-feeds',
    cacheControl: `max-age=${60 * 5}` // 5 minutes
  }),
  rssHandler
);

// Audio redirect endpoint
app.get('/audio/:podcastId/:episodeId', audioHandler);

// Fallback for undefined routes
app.notFound((c) => {
  return c.text('Not Found', 404);
});

// Error handling
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.text('Internal Server Error', 500);
});

export default app;