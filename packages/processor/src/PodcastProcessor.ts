import cron from 'node-cron';
import { ConfigManager } from './config/ConfigManager';
import { JobManager } from './jobs/JobManager';
import { DatabaseManager } from './database/DatabaseManager';
import { RSSProcessor } from './rss/RSSProcessor';
import { StorageManager } from './storage/StorageManager';
import { AudioProcessor } from './audio/AudioProcessor';
import { LLMOrchestrator } from './llm/LLMOrchestrator';
import { PodcastConfig, ProcessingResult } from '@podcastoor/shared';

export class PodcastProcessor {
  private config: ConfigManager;
  private database!: DatabaseManager;
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
      await this.initializeServices();
      await this.jobManager.start();
      this.setupCronJobs();
      this.config.startWatching();
      
      this.isRunning = true;
      console.log('PodcastProcessor started successfully');
      
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
      this.cronJobs.forEach((task, name) => {
        task.stop();
        console.log(`Stopped cron job: ${name}`);
      });
      this.cronJobs.clear();

      this.config.stopWatching();
      await this.jobManager.stop();

      if (this.audioProcessor) {
        await this.audioProcessor.cleanup();
      }

      this.database.close();
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

      // Check if we need to fetch RSS (avoid unnecessary fetches)
      const state = await this.database.getPodcastState(podcastId);
      const now = new Date();
      const lastFetch = state?.lastRSSFetch || new Date(0);
      const hoursSinceLastFetch = (now.getTime() - lastFetch.getTime()) / (1000 * 60 * 60);

      if (hoursSinceLastFetch < 1) {
        console.log(`RSS recently fetched for ${podcastId}, skipping`);
        
        // Still queue any unprocessed episodes
        await this.queueUnprocessedEpisodes(podcastId);
        return;
      }

      // Fetch RSS feed
      const feed = await this.rssProcessor.fetchFeed(podcast.rssUrl);
      console.log(`Fetched RSS feed: ${feed.title} (${feed.episodes.length} episodes)`);

      // Save/update podcast information in database
      await this.database.savePodcast(podcastId, feed.title, feed.description, podcast.rssUrl);

      // Calculate retention cutoff date
      const retentionDays = podcast.retentionDays || this.config.getProcessingConfig().defaultRetentionDays;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      console.log(`Retention policy: ${retentionDays} days (cutoff: ${cutoffDate.toISOString()})`);

      // Store/update episodes in database
      const newEpisodes: number[] = [];
      let skippedOldEpisodes = 0;
      
      for (const episode of feed.episodes) {
        // Skip episodes older than retention policy
        if (episode.publishDate < cutoffDate) {
          skippedOldEpisodes++;
          continue;
        }

        const isProcessed = await this.database.isEpisodeProcessed(podcastId, episode.guid);
        if (!isProcessed) {
          const episodeId = await this.database.upsertEpisode(podcastId, episode);
          newEpisodes.push(episodeId);
        }
      }

      if (skippedOldEpisodes > 0) {
        console.log(`Skipped ${skippedOldEpisodes} episodes older than ${retentionDays} days`);
      }

      console.log(`Found ${newEpisodes.length} new episodes to process`);

      // Queue new episodes for processing
      for (const episodeId of newEpisodes) {
        await this.jobManager.addPodcastProcessingJob(episodeId, 10);
      }

      // Update podcast state
      await this.database.updatePodcastState(podcastId, {
        lastRSSFetch: now,
        lastProcessed: now,
        totalEpisodes: feed.episodes.length,
        processedEpisodes: feed.episodes.length - newEpisodes.length
      });

      // Generate and upload RSS feed
      await this.generateAndUploadRSSFeed(podcastId);

    } catch (error) {
      this.handleProcessingError(error as Error, podcastId);
    }
  }

  private async queueUnprocessedEpisodes(podcastId: string): Promise<void> {
    const unprocessed = await this.database.getUnprocessedEpisodes(podcastId);
    
    for (const episode of unprocessed) {
      await this.jobManager.addPodcastProcessingJob(episode.id, 5);
    }
    
    if (unprocessed.length > 0) {
      console.log(`Queued ${unprocessed.length} unprocessed episodes for ${podcastId}`);
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
        lastProcessingRun: null // Could get from database
      };
    } catch (error) {
      console.error('Failed to get processing stats:', error);
      return {
        queueStats: { waiting: 0, active: 0, completed: 0, failed: 0 },
        configuredPodcasts: 0,
        enabledPodcasts: 0,
        lastProcessingRun: null
      };
    }
  }

  private async initializeServices(): Promise<void> {
    const processingConfig = this.config.getProcessingConfig();
    const llmConfig = this.config.getLLMConfig();
    const storageConfig = this.config.getStorageConfig();
    const databaseConfig = this.config.getDatabaseConfig();
    const jobsConfig = this.config.getJobsConfig();

    // Initialize database first (standalone)
    this.database = new DatabaseManager({ dbPath: databaseConfig.path });

    // Initialize other services
    this.audioProcessor = new AudioProcessor({
      tempDirectory: processingConfig.tempDirectory,
      maxDuration: processingConfig.maxDuration,
      timeoutMs: processingConfig.timeoutMinutes * 60 * 1000
    });

    this.llmOrchestrator = new LLMOrchestrator(llmConfig);
    this.storageManager = new StorageManager(storageConfig);
    this.rssProcessor = new RSSProcessor();
    
    // Initialize job manager with all required dependencies
    this.jobManager = new JobManager(
      jobsConfig, 
      this.database,
      this.audioProcessor,
      this.llmOrchestrator,
      this.storageManager,
      this.rssProcessor
    );

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

    const processAllTask = cron.schedule('0 * * * *', async () => {
      console.log('Scheduled podcast processing started');
      await this.processAllPodcasts();
    }, { scheduled: false });

    const cleanupTask = cron.schedule('0 2 * * *', async () => {
      console.log('Scheduled cleanup started');
      await this.jobManager.addCleanupJob(30);
    }, { scheduled: false });

    processAllTask.start();
    cleanupTask.start();

    this.cronJobs.set('processAll', processAllTask);
    this.cronJobs.set('cleanup', cleanupTask);

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

  private async generateAndUploadRSSFeed(podcastId: string): Promise<void> {
    try {
      const podcast = await this.config.getPodcast(podcastId);
      if (!podcast) return;

      // Get original feed
      const originalFeed = await this.rssProcessor.fetchFeed(podcast.rssUrl);
      
      // Get processing results from database
      const processingResults = await this.database.getProcessingResults(podcastId);
      
      // Generate processed RSS feed
      const processedFeedXML = await this.rssProcessor.generateProcessedFeed(originalFeed, processingResults);
      
      // Upload to storage
      const uploadResult = await this.storageManager.uploadRSSFeed(podcastId, processedFeedXML);
      
      console.log(`RSS feed uploaded: ${uploadResult.url}`);
    } catch (error) {
      console.error(`Failed to generate RSS feed for ${podcastId}:`, error);
    }
  }

  getDatabaseManager(): DatabaseManager {
    return this.database;
  }

  getStorageManager(): StorageManager {
    return this.storageManager;
  }
}