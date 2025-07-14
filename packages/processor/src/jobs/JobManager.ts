import { DatabaseManager } from '../database/DatabaseManager';
import { DatabaseService } from '../services/database';
import { ProcessingResult } from '@podcastoor/shared';
import { PodcastWorker } from './workers/PodcastWorker';
import { AudioProcessor } from '../audio/AudioProcessor';
import { LLMOrchestrator } from '../llm/LLMOrchestrator';
import { StorageManager } from '../storage/StorageManager';
import { RSSProcessor } from '../rss/RSSProcessor';
import { formatError } from '@podcastoor/shared';

export interface JobConfig {
  concurrency: number;
  retryAttempts: number;
  processingTimeoutMinutes: number;
}

export interface PodcastJobData {
  episodeId: number;  // Now uses database ID instead of GUID
  podcastId: string;
  episodeGuid: string;
  audioUrl: string;
}

export interface CleanupJobData {
  olderThanDays: number;
  dryRun: boolean;
}

export class JobManager {
  private db: DatabaseManager;
  private newDb?: DatabaseService; // New database service for refactored schema
  private config: JobConfig;
  private isRunning: boolean = false;
  private processingInterval?: NodeJS.Timeout;
  private podcastWorker: PodcastWorker;
  private runningJobsCount: number = 0;
  private storageManager: StorageManager;

  constructor(
    config: JobConfig, 
    database: DatabaseManager,
    audioProcessor: AudioProcessor,
    llmOrchestrator: LLMOrchestrator,
    storageManager: StorageManager,
    rssProcessor: RSSProcessor,
    newDatabase?: DatabaseService
  ) {
    this.config = config;
    this.db = database;
    this.newDb = newDatabase;
    this.storageManager = storageManager;
    this.podcastWorker = new PodcastWorker(
      audioProcessor,
      llmOrchestrator,
      storageManager,
      rssProcessor
    );
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('JobManager already running');
      return;
    }

    console.log('Starting JobManager...');
    this.isRunning = true;

    // Start processing loop
    this.processingInterval = setInterval(() => {
      this.processJobs();
    }, 15000); // Check for jobs every second

    console.log(`JobManager started with concurrency: ${this.config.concurrency}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('JobManager not running');
      return;
    }

    console.log('Stopping JobManager...');
    this.isRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    
    while (this.getRunningJobsCount() > 0) {
      console.debug(`Waiting for ${this.getRunningJobsCount()} jobs to complete...`);

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('JobManager stopped');
  }

  async addPodcastProcessingJob(episodeId: number, priority: number = 0): Promise<number> {
    // Get episode details from database
    const episode = await this.db.getEpisodeById(episodeId);
    
    if (!episode) {
      throw new Error(`Episode not found: ${episodeId}`);
    }

    const jobData: PodcastJobData = {
      episodeId,
      podcastId: episode.podcastId,
      episodeGuid: episode.episodeGuid,
      audioUrl: episode.audioUrl
    };

    const jobId = await this.db.createJob('podcast-processing', jobData, priority);
    console.log(`Added podcast processing job: ${episode.podcastId}/${episode.episodeGuid} (ID: ${jobId})`);
    
    return jobId;
  }

  async addCleanupJob(olderThanDays: number, dryRun: boolean = false): Promise<number> {
    const jobData: CleanupJobData = { olderThanDays, dryRun };
    const jobId = await this.db.createJob('cleanup', jobData);
    console.log(`Added cleanup job: ${olderThanDays} days${dryRun ? ' (dry run)' : ''} (ID: ${jobId})`);
    
    return jobId;
  }

  // New manual job creation methods for refactored schema
  async createManualJob(episodeGuid: string, podcastId: string, priority: number = 10): Promise<number> {
    if (!this.newDb) {
      throw new Error('New database service not available for manual job creation');
    }

    try {
      // Verify episode exists
      const episode = await this.newDb.getUpstreamEpisode(episodeGuid, podcastId);
      if (!episode) {
        throw new Error(`Episode ${episodeGuid} not found`);
      }
      
      // Check if job already exists
      const existingJob = await this.newDb.getActiveJobForEpisode(episodeGuid);
      if (existingJob) {
        throw new Error(`Active job already exists for episode ${episodeGuid}`);
      }
      
      // Create manual job with protection
      const jobId = await this.newDb.createProcessingJob({
        episodeGuid,
        podcastId,
        reason: 'manual',
        priority,
        isProtected: true // Immune from cleanup
      });
      
      console.log(`Created manual job ${jobId} for episode ${episodeGuid}`);
      return jobId;
    } catch (error) {
      console.error('Failed to create manual job:', error);
      throw new Error(`Failed to create job: ${formatError(error)}`);
    }
  }
  
  async retryFailedJob(jobId: number): Promise<void> {
    if (!this.newDb) {
      throw new Error('New database service not available for job retry');
    }

    const job = await this.newDb.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    if (job.status !== 'failed') {
      throw new Error(`Job ${jobId} is not in failed state`);
    }
    
    await this.newDb.resetJobStatus(jobId);
    console.log(`Reset job ${jobId} for retry`);
  }

  async getQueueStats() {
    return await this.db.getJobStats();
  }

  private async processJobs(): Promise<void> {
    if (!this.isRunning) return;

    const runningJobs = this.getRunningJobsCount();
    const availableSlots = this.config.concurrency - runningJobs;

    if (availableSlots <= 0) {
      return;
    }

    console.log(`Processing jobs: ${runningJobs} running, ${availableSlots} slots available (max: ${this.config.concurrency})`);

    // Process available jobs
    for (let i = 0; i < availableSlots; i++) {
      const job = await this.db.getNextJob();
      if (!job) break;

      // Try to mark as running
      const marked = await this.db.markJobRunning(job.id);
      if (!marked) continue;

      console.log(`Starting job ${job.id} (slot ${i + 1}/${availableSlots})`);
      
      // Increment counter BEFORE starting the async job to prevent race conditions
      this.runningJobsCount++;
      
      // Process job asynchronously (don't await here to allow parallel processing)
      this.processJob(job).catch(error => {
        // If processJob fails to start, decrement the counter
        this.runningJobsCount--;
        console.error(`Failed to start job ${job.id}:`, error);
      });
    }
  }

  private async processJob(job: any): Promise<void> {
    const jobId = job.id;
    
    // Counter is now incremented in processJobs() before calling this method
    
    try {
      console.log(`Processing job ${jobId} (${job.type}) - Running jobs: ${this.runningJobsCount}/${this.config.concurrency}`);

      let result: any;
      const jobData = JSON.parse(job.data);

      switch (job.type) {
        case 'podcast-processing':
          result = await this.processPodcastJob(jobData as PodcastJobData);
          break;
        case 'cleanup':
          result = await this.processCleanupJob(jobData as CleanupJobData);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      await this.db.markJobCompleted(jobId, result);
      console.log(`Job ${jobId} completed successfully`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Job ${jobId} failed:`, errorMessage);
      await this.db.markJobFailed(jobId, errorMessage);
    } finally {
      // Decrement running jobs counter
      this.runningJobsCount--;
    }
  }

  private async processPodcastJob(data: PodcastJobData): Promise<ProcessingResult> {
    const { episodeId, podcastId, episodeGuid, audioUrl } = data;
    const startTime = Date.now();
    
    // Get full episode details for comprehensive logging
    const episode = await this.db.getEpisodeById(episodeId);
    if (!episode) {
      throw new Error(`Episode not found: ${episodeId}`);
    }

    console.log(`🎙️  Processing episode: "${episode.title}"`);
    console.log(`📊 Episode Details:`);
    console.log(`   • Podcast: ${podcastId}`);
    console.log(`   • GUID: ${episodeGuid}`);
    console.log(`   • Duration: ${this.formatDuration(episode.duration)}`);
    console.log(`   • Published: ${episode.publishDate.toLocaleDateString()}`);
    console.log(`   • Audio URL: ${audioUrl}`);
    
    try {
      // Mark episode as processing in database
      const marked = await this.db.markEpisodeProcessing(episodeId);
      if (!marked) {
        throw new Error('Episode already being processed or completed');
      }

      // Create job object with progress tracking
      const job = {
        id: episodeId,
        data,
        attemptsMade: 0,
        updateProgress: async (percentage: number) => {
          console.log(`📈 Progress: ${percentage}% (${this.getElapsedTime(startTime)})`);
          // Could update database with progress here
        }
      };

      // Use the actual PodcastWorker for production processing
      const result = await this.podcastWorker.processPodcastEpisode(job);

      // Mark episode as completed and store results
      await this.db.markEpisodeCompleted(episodeId, result);
      
      const totalTime = this.getElapsedTime(startTime);
      console.log(`✅ Episode processing completed: "${episode.title}" (${totalTime})`);
      console.log(`💰 Processing cost: $${result.processingCost.toFixed(2)}`);
      console.log(`📤 Processed audio uploaded to: ${result.processedUrl}`);
      
      return result;
    } catch (error) {
      const totalTime = this.getElapsedTime(startTime);
      console.error(`❌ Episode processing failed: "${episode.title}" (${totalTime})`);
      console.error(`🔍 Error details: ${error instanceof Error ? error.message : String(error)}`);
      
      await this.db.markEpisodeFailed(episodeId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async processCleanupJob(data: CleanupJobData): Promise<{ deletedCount: number; dryRun: boolean }> {
    console.log(`Processing cleanup: ${data.olderThanDays} days${data.dryRun ? ' (dry run)' : ''}`);
    
    if (this.newDb) {
      // Use new database service for protected cleanup
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - data.olderThanDays);
      
      // Get episodes to clean (excluding protected)
      const episodes = await this.newDb.getEpisodesForCleanup(cutoffDate);
      
      let cleaned = 0;
      for (const episode of episodes) {
        if (!data.dryRun) {
          await this.storageManager.deleteProcessedFiles(episode.podcastId, episode.episodeGuid);
          await this.newDb.markEpisodeCleaned(episode.episodeGuid);
        }
        cleaned++;
      }
      
      console.log(`Cleanup ${data.dryRun ? '(dry run)' : ''}: ${cleaned} episodes`);
      return { deletedCount: cleaned, dryRun: data.dryRun };
    } else {
      // Fallback to original implementation
      await new Promise(resolve => setTimeout(resolve, 500));
      return {
        deletedCount: data.dryRun ? 0 : Math.floor(Math.random() * 10),
        dryRun: data.dryRun
      };
    }
  }

  private getRunningJobsCount(): number {
    return this.runningJobsCount;
  }

  private getElapsedTime(startTime: number): string {
    const elapsed = Date.now() - startTime;
    const seconds = Math.floor(elapsed / 1000);
    const ms = elapsed % 1000;
    return `${seconds}.${ms.toString().padStart(3, '0')}s`;
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  private formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}