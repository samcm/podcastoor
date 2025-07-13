import cron from 'node-cron';
import { ConfigManager } from './config/ConfigManager.js';
import { JobManager } from './jobs/JobManager.js';
import { RSSProcessor } from './rss/RSSProcessor.js';
import { StorageManager } from './storage/StorageManager.js';
import { AudioProcessor } from './audio/AudioProcessor.js';
import { LLMOrchestrator } from './llm/LLMOrchestrator.js';
import { PodcastConfig, ProcessingResult } from '@podcastoor/shared';

export class PodcastProcessor {
  private config: ConfigManager;
  private jobManager!: JobManager;
  private rssProcessor!: RSSProcessor;
  private storageManager!: StorageManager;
  private audioProcessor!: AudioProcessor;
  private llmOrchestrator!: LLMOrchestrator;
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private isRunning: boolean = false;

  constructor(configPath: string = './config') {
    this.config = new ConfigManager(configPath);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('PodcastProcessor already running');
      return;
    }

    console.log('Starting PodcastProcessor...');

    try {
      // Initialize configuration
      await this.initializeServices();
      
      // Start job manager
      await this.jobManager.start();
      
      // Setup scheduled tasks
      this.setupCronJobs();
      
      // Start configuration watching
      this.config.startWatching();
      
      this.isRunning = true;
      console.log('PodcastProcessor started successfully');
      
      // Process existing podcasts on startup
      await this.processAllPodcasts();
      
    } catch (error) {
      console.error('Failed to start PodcastProcessor:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('PodcastProcessor not running');
      return;
    }

    console.log('Stopping PodcastProcessor...');

    try {
      // Stop cron jobs
      this.cronJobs.forEach((task, name) => {
        task.destroy();
        console.log(`Stopped cron job: ${name}`);
      });
      this.cronJobs.clear();

      // Stop configuration watching
      this.config.stopWatching();

      // Stop job manager
      await this.jobManager.stop();

      // Cleanup audio processor
      if (this.audioProcessor) {
        await this.audioProcessor.cleanup();
      }

      this.isRunning = false;
      console.log('PodcastProcessor stopped');
    } catch (error) {
      console.error('Error stopping PodcastProcessor:', error);
    }
  }

  async processAllPodcasts(): Promise<void> {
    console.log('Processing all enabled podcasts...');

    try {
      const podcasts = await this.config.loadPodcasts();
      console.log(`Found ${podcasts.length} enabled podcasts`);

      for (const podcast of podcasts) {
        await this.processPodcast(podcast.id);
      }

      console.log('All podcasts processed');
    } catch (error) {
      console.error('Failed to process all podcasts:', error);
    }
  }

  async processPodcast(podcastId: string): Promise<void> {
    console.log(`Processing podcast: ${podcastId}`);

    try {
      const podcast = await this.config.getPodcast(podcastId);
      if (!podcast) {
        throw new Error(`Podcast not found: ${podcastId}`);
      }

      if (!podcast.enabled) {
        console.log(`Podcast disabled: ${podcastId}`);
        return;
      }

      // Fetch RSS feed
      const feed = await this.rssProcessor.fetchFeed(podcast.rssUrl);
      console.log(`Fetched RSS feed: ${feed.title} (${feed.episodes.length} episodes)`);

      // Get last processed timestamp (could be stored in SQLite)
      const lastProcessed = this.getLastProcessedTime(podcastId);
      
      // Filter new episodes
      const newEpisodes = await this.rssProcessor.filterNewEpisodes(feed.episodes, lastProcessed);
      console.log(`Found ${newEpisodes.length} new episodes`);

      // Queue new episodes for processing
      for (const episode of newEpisodes) {
        await this.jobManager.addPodcastProcessingJob(
          podcastId,
          episode.guid,
          episode.audioUrl,
          10 // High priority for new episodes
        );
        console.log(`Queued episode: ${episode.title}`);
      }

      // Update last processed timestamp
      this.setLastProcessedTime(podcastId, new Date());

    } catch (error) {
      this.handleProcessingError(error as Error, podcastId);
    }
  }

  async cleanupOldFiles(): Promise<void> {
    console.log('Starting cleanup of old files...');

    try {
      const processingConfig = this.config.getProcessingConfig();
      
      // Queue cleanup job
      await this.jobManager.addCleanupJob(
        processingConfig.defaultRetentionDays,
        false // Not a dry run
      );

      console.log('Cleanup job queued');
    } catch (error) {
      console.error('Failed to queue cleanup job:', error);
    }
  }

  async getProcessingStats(): Promise<{
    queueStats: any;
    configuredPodcasts: number;
    enabledPodcasts: number;
    lastProcessingRun: Date | null;
  }> {
    try {
      const [queueStats, enabledPodcasts, allPodcasts] = await Promise.all([
        this.jobManager.getQueueStats(),
        this.config.loadPodcasts(),
        this.config.getAllPodcasts()
      ]);

      return {
        queueStats,
        configuredPodcasts: allPodcasts.length,
        enabledPodcasts: enabledPodcasts.length,
        lastProcessingRun: this.getLastGlobalProcessingTime()
      };
    } catch (error) {
      console.error('Failed to get processing stats:', error);
      return {
        queueStats: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        configuredPodcasts: 0,
        enabledPodcasts: 0,
        lastProcessingRun: null
      };
    }
  }

  private async initializeServices(): Promise<void> {
    // Initialize services with configuration
    const processingConfig = this.config.getProcessingConfig();
    const llmConfig = this.config.getLLMConfig();
    const storageConfig = this.config.getStorageConfig();
    const jobsConfig = this.config.getJobsConfig();

    // Initialize services
    this.audioProcessor = new AudioProcessor({
      tempDirectory: processingConfig.tempDirectory,
      maxDuration: processingConfig.maxDuration,
      timeoutMs: processingConfig.timeoutMinutes * 60 * 1000
    });

    this.llmOrchestrator = new LLMOrchestrator(llmConfig);
    this.storageManager = new StorageManager(storageConfig);
    this.rssProcessor = new RSSProcessor();

    this.jobManager = new JobManager(jobsConfig);

    // Test connections
    console.log('Testing service connections...');
    
    const storageConnected = await this.storageManager.testConnection();
    if (!storageConnected) {
      throw new Error('Failed to connect to storage');
    }
    console.log('✓ Storage connection successful');

    console.log('✓ All services initialized');
  }

  private setupCronJobs(): void {
    console.log('Setting up scheduled tasks...');

    // Process all podcasts every hour
    const processAllTask = cron.schedule('0 * * * *', async () => {
      console.log('Scheduled podcast processing started');
      await this.processAllPodcasts();
    }, {
      scheduled: false
    });

    // Cleanup old files daily at 2 AM
    const cleanupTask = cron.schedule('0 2 * * *', async () => {
      console.log('Scheduled cleanup started');
      await this.cleanupOldFiles();
    }, {
      scheduled: false
    });

    // Retry failed jobs every 30 minutes
    const retryTask = cron.schedule('*/30 * * * *', async () => {
      console.log('Retrying failed jobs...');
      const retriedCount = await this.jobManager.retryFailedJobs();
      console.log(`Retried ${retriedCount} failed jobs`);
    }, {
      scheduled: false
    });

    // Start all tasks
    processAllTask.start();
    cleanupTask.start();
    retryTask.start();

    // Store references
    this.cronJobs.set('processAll', processAllTask);
    this.cronJobs.set('cleanup', cleanupTask);
    this.cronJobs.set('retry', retryTask);

    console.log('✓ Scheduled tasks configured');
  }

  private handleProcessingError(error: Error, podcastId: string): void {
    console.error(`Processing error for podcast ${podcastId}:`, {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      podcastId
    });

    // Could implement alerting/monitoring here
    // await this.notifyError(error, podcastId);
  }

  private getLastProcessedTime(podcastId: string): Date {
    // In a real implementation, this would read from SQLite
    const defaultTime = new Date();
    defaultTime.setHours(defaultTime.getHours() - 24);
    return defaultTime;
  }

  private setLastProcessedTime(podcastId: string, time: Date): void {
    // In a real implementation, this would write to SQLite
    console.log(`Last processed time for ${podcastId}: ${time.toISOString()}`);
  }

  private getLastGlobalProcessingTime(): Date | null {
    // In a real implementation, this would read from SQLite
    return null;
  }
}