import { DatabaseManager } from '../database/DatabaseManager';
import { ProcessingResult } from '@podcastoor/shared';

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
  private config: JobConfig;
  private isRunning: boolean = false;
  private processingInterval?: NodeJS.Timeout;

  constructor(config: JobConfig, database: DatabaseManager) {
    this.config = config;
    this.db = database;
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
    }, 1000); // Check for jobs every second

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

    // Wait for running jobs to complete
    let attempts = 0;
    const maxAttempts = 30;
    
    while (this.getRunningJobsCount() > 0 && attempts < maxAttempts) {
      console.log(`Waiting for ${this.getRunningJobsCount()} jobs to complete...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
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

  async getQueueStats() {
    return await this.db.getJobStats();
  }

  private async processJobs(): Promise<void> {
    if (!this.isRunning) return;

    const runningJobs = this.getRunningJobsCount();
    const availableSlots = this.config.concurrency - runningJobs;

    if (availableSlots <= 0) return;

    // Process available jobs
    for (let i = 0; i < availableSlots; i++) {
      const job = await this.db.getNextJob();
      if (!job) break;

      // Try to mark as running
      const marked = await this.db.markJobRunning(job.id);
      if (!marked) continue;

      this.processJob(job);
    }
  }

  private async processJob(job: any): Promise<void> {
    const jobId = job.id;
    
    try {
      console.log(`Processing job ${jobId} (${job.type})`);

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
    }
  }

  private async processPodcastJob(data: PodcastJobData): Promise<ProcessingResult> {
    const { episodeId, podcastId, episodeGuid, audioUrl } = data;
    
    console.log(`Processing episode: ${podcastId}/${episodeGuid}`);
    
    try {
      // Mark episode as processing in database
      const marked = await this.db.markEpisodeProcessing(episodeId);
      if (!marked) {
        throw new Error('Episode already being processed or completed');
      }

      // Here would be the actual processing logic
      // For now, return mock result
      await new Promise(resolve => setTimeout(resolve, 1000));

      const result: ProcessingResult = {
        podcastId,
        episodeId: episodeGuid,
        originalUrl: audioUrl,
        processedUrl: `https://storage.example.com/processed/${podcastId}/${episodeGuid}.mp3`,
        adsRemoved: [],
        chapters: [],
        processingCost: 0.05,
        processedAt: new Date()
      };

      // Mark episode as completed and store results
      await this.db.markEpisodeCompleted(episodeId, result);
      
      console.log(`Episode processing completed: ${podcastId}/${episodeGuid}`);
      return result;
    } catch (error) {
      await this.db.markEpisodeFailed(episodeId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async processCleanupJob(data: CleanupJobData): Promise<{ deletedCount: number; dryRun: boolean }> {
    console.log(`Processing cleanup: ${data.olderThanDays} days${data.dryRun ? ' (dry run)' : ''}`);
    
    await new Promise(resolve => setTimeout(resolve, 500));

    return {
      deletedCount: data.dryRun ? 0 : Math.floor(Math.random() * 10),
      dryRun: data.dryRun
    };
  }

  private getRunningJobsCount(): number {
    // This would query the database, but for now return 0
    return 0;
  }
}