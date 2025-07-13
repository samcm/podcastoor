import { PodcastProcessor } from './PodcastProcessor.js';

async function main() {
  const configPath = process.env.CONFIG_PATH || './config';
  const processor = new PodcastProcessor(configPath);

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
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
    
    // Keep the process running
    console.log('Processor is running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('Failed to start processor:', error);
    process.exit(1);
  }
}

// Export the processor class for programmatic use
export { PodcastProcessor } from './PodcastProcessor.js';

// Export other modules for external use
export * from './llm/index.js';
export * from './audio/index.js';
export * from './storage/index.js';
export * from './rss/index.js';
export * from './jobs/index.js';
export * from './api/index.js';

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}