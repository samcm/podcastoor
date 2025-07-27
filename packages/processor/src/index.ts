import 'dotenv/config';
import { PodcastProcessor } from './PodcastProcessor';
import { createAPIServer } from './api/server';
import { serve } from '@hono/node-server';

async function main() {
  const configPath = process.env.CONFIG_PATH || './config';
  const configFile = process.env.CONFIG_FILE || 'config.yaml';
  console.log('🚀 Starting Podcastoor Processor');
  console.log(`📁 Config path: ${configPath}`);
  console.log(`📄 Config file: ${configFile}`);
  const processor = new PodcastProcessor(configPath);


  console.log('Starting Podcastoor processor...');
  await processor.start();
  
  // Start HTTP API server
  const app = createAPIServer(processor);
  const port = process.env.PORT || 3000;
  
  console.log(`Starting HTTP server on port ${port}...`);
  serve({
    fetch: app.fetch,
    port: Number(port),
  });
  
  console.log(`Processor is running. HTTP server available at http://localhost:${port}`);
  console.log(`Web UI: http://localhost:${port}/`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log('Press Ctrl+C to stop.');
  
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