import { PodcastProcessor } from './PodcastProcessor';
import { createAPIServer } from './api/server';
import { serve } from '@hono/node-server';

async function main() {
  const configPath = process.env.CONFIG_PATH || './config';
  const processor = new PodcastProcessor(configPath);

  let server: any = null;

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      if (server) {
        console.log('Stopping HTTP server...');
        server.close();
      }
      await processor.stop();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGUSR2', () => shutdown('SIGUSR2')); // For nodemon

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown('unhandledRejection');
  });

  try {
    console.log('Starting Podcastoor processor...');
    await processor.start();
    
    // Start HTTP API server
    const app = createAPIServer(processor);
    const port = process.env.PORT || 3000;
    
    console.log(`Starting HTTP server on port ${port}...`);
    server = serve({
      fetch: app.fetch,
      port: Number(port),
    });
    
    console.log(`Processor is running. HTTP server available at http://localhost:${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log('Press Ctrl+C to stop.');
    
  } catch (error) {
    console.error('Failed to start processor:', error);
    process.exit(1);
  }
}

// Export the processor class for programmatic use
export { PodcastProcessor } from './PodcastProcessor';

// Export other modules for external use
export * from './llm/index';
export * from './audio/index';
export * from './storage/index';
export * from './rss/index';
export * from './jobs/index';
export * from './api/index';
export * from './database/index';

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}