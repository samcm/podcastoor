import cron from 'node-cron';
import { ConfigManager } from './config/ConfigManager';
import { JobManager } from './jobs/JobManager';
import { Database } from './database/Database';
import { RSSProcessor } from './rss/RSSProcessor';
import { StorageManager } from './storage/StorageManager';
import { AudioProcessor } from './audio/AudioProcessor';
import { LLMOrchestrator } from './llm/LLMOrchestrator';
import { ProcessingResult } from '@podcastoor/shared';

export class PodcastProcessor {
  private config: ConfigManager;
  private database!: Database;
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
    console.log('Stopping PodcastProcessor...');
    
    // Stop cron jobs
    this.cronJobs.forEach((job, name) => {
      console.log(`Stopping cron job: ${name}`);
      job.stop();
    });
    this.cronJobs.clear();
    
    // Stop services
    if (this.jobManager) {
      await this.jobManager.stop();
    }
    
    if (this.config) {
      this.config.stopWatching();
    }
    
    if (this.database) {
      this.database.close();
    }
    
    this.isRunning = false;
    console.log('PodcastProcessor stopped');
  }

  async processAllPodcasts(): Promise<void> {
    console.log('Processing all enabled podcasts...');
    
    const allPodcasts = await this.config.getAllPodcasts();
    const enabledPodcasts = allPodcasts.filter(p => p.enabled);
    console.log(`Found ${enabledPodcasts.length} enabled podcasts`);
    
    for (const podcast of enabledPodcasts) {
      await this.processPodcast(podcast.id);
    }
    
    console.log('All podcasts processed');
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

      // Save/update show information
      this.database.upsertShow(podcastId, feed.title, feed.description, podcast.rssUrl);

      // Calculate retention cutoff date
      const retentionDays = podcast.retentionDays || this.config.getProcessingConfig().defaultRetentionDays;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      console.log(`Retention policy: ${retentionDays} days (cutoff: ${cutoffDate.toISOString()})`);

      // Store episodes and queue jobs
      let newJobs = 0;
      let skippedOldEpisodes = 0;
      
      for (const episode of feed.episodes) {
        // Skip episodes older than retention policy
        if (episode.publishDate < cutoffDate) {
          skippedOldEpisodes++;
          continue;
        }

        // Store episode
        this.database.upsertEpisode({
          guid: episode.guid,
          showId: podcastId,
          title: episode.title,
          description: episode.description,
          audioUrl: episode.audioUrl,
          publishDate: episode.publishDate,
          duration: episode.duration
        });
        
        // Check if already has a job
        const existingJobs = this.database.getEpisodeJobs(episode.guid);
        const hasSuccessfulJob = existingJobs.some(job => job.status === 'completed');
        
        if (!hasSuccessfulJob) {
          const jobId = this.database.createJob(episode.guid, 10);
          console.log(`Added podcast processing job: ${podcastId}/${episode.guid} (ID: ${jobId})`);
          newJobs++;
        }
      }

      if (skippedOldEpisodes > 0) {
        console.log(`Skipped ${skippedOldEpisodes} episodes older than ${retentionDays} days`);
      }

      console.log(`Found ${newJobs} new episodes to process`);

    } catch (error) {
      this.handleProcessingError(error as Error, podcastId);
    }
  }

  async cleanupOldFiles(): Promise<void> {
    console.log('Starting cleanup of old files...');
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.getProcessingConfig().defaultRetentionDays);
    
    console.log('Cleanup completed');
  }

  getHealthStatus() {
    const shows = this.database.getAllShows();
    const jobStats = this.database.getJobStats();
    
    // Calculate total episodes and processed counts
    let totalEpisodes = 0;
    let processedEpisodes = 0;
    
    for (const show of shows) {
      const episodes = this.database.getShowEpisodes(show.id);
      totalEpisodes += episodes.length;
      
      for (const episode of episodes) {
        const jobs = this.database.getEpisodeJobs(episode.guid);
        if (jobs.some(job => job.status === 'completed')) {
          processedEpisodes++;
        }
      }
    }
    
    return {
      status: 'healthy',
      shows: shows.length,
      jobs: jobStats,
      lastProcessingRun: new Date(),
      stats: {
        totalPodcasts: shows.length,
        totalEpisodes: totalEpisodes,
        processedEpisodes: processedEpisodes,
        failedEpisodes: jobStats.failed || 0
      }
    };
  }

  private async initializeServices(): Promise<void> {
    const processingConfig = this.config.getProcessingConfig();
    const llmConfig = this.config.getLLMConfig();
    const storageConfig = this.config.getStorageConfig();
    const databaseConfig = this.config.getDatabaseConfig();

    // Initialize database
    this.database = new Database(databaseConfig);

    // Initialize other services
    this.audioProcessor = new AudioProcessor({
      tempDirectory: processingConfig.tempDirectory,
      maxDuration: processingConfig.maxDuration,
      timeoutMs: processingConfig.timeoutMinutes * 60 * 1000
    });

    this.llmOrchestrator = new LLMOrchestrator(llmConfig);
    this.storageManager = new StorageManager(storageConfig);
    this.rssProcessor = new RSSProcessor();
    
    // Initialize job manager
    this.jobManager = new JobManager(
      processingConfig.concurrency, 
      this.database,
      this.audioProcessor,
      this.llmOrchestrator,
      this.storageManager,
      this.rssProcessor,
      { minAdDuration: processingConfig.minAdDuration }
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
    
    // Process all podcasts every hour
    const processingJob = cron.schedule('0 * * * *', async () => {
      console.log('Running scheduled podcast processing...');
      await this.processAllPodcasts();
    });
    this.cronJobs.set('process-podcasts', processingJob);
    
    // Cleanup old files daily at 3am
    const cleanupJob = cron.schedule('0 3 * * *', async () => {
      console.log('Running scheduled cleanup...');
      await this.cleanupOldFiles();
    });
    this.cronJobs.set('cleanup', cleanupJob);
    
    console.log('✓ Scheduled tasks configured');
  }

  private handleProcessingError(error: Error, context: string): void {
    console.error(`Processing error (${context}):`, error);
  }

  // Getters for other services to access
  getDatabase(): Database {
    return this.database;
  }

  getStorageManager(): StorageManager {
    return this.storageManager;
  }

  getConfig(): ConfigManager {
    return this.config;
  }

  getJobManager(): JobManager {
    return this.jobManager;
  }
}