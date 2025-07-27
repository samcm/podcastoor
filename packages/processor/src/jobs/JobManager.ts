import { Database } from '../database/Database';
import { ProcessingResult } from '@podcastoor/shared';
import { PodcastWorker } from './workers/PodcastWorker';
import { AudioProcessor } from '../audio/AudioProcessor';
import { LLMOrchestrator } from '../llm/LLMOrchestrator';
import { StorageManager } from '../storage/StorageManager';
import { RSSProcessor } from '../rss/RSSProcessor';
import { formatError } from '@podcastoor/shared';

export class JobManager {
  private db: Database;
  private concurrency: number;
  private processingConfig: { minAdDuration: number };
  private isRunning: boolean = false;
  private processingInterval?: NodeJS.Timeout;
  private podcastWorker: PodcastWorker;
  private runningJobsCount: number = 0;
  private storageManager: StorageManager;

  constructor(
    concurrency: number, 
    database: Database,
    audioProcessor: AudioProcessor,
    llmOrchestrator: LLMOrchestrator,
    storageManager: StorageManager,
    rssProcessor: RSSProcessor,
    processingConfig: { minAdDuration: number }
  ) {
    this.concurrency = concurrency;
    this.db = database;
    this.storageManager = storageManager;
    this.processingConfig = processingConfig;
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
    this.runningJobsCount = 0;
    
    // Start processing loop
    this.processingInterval = setInterval(() => {
      this.processJobs();
    }, 5000); // Check every 5 seconds
    
    console.log(`JobManager started with concurrency: ${this.concurrency}`);
  }

  async stop(): Promise<void> {
    console.log('Stopping JobManager...');
    this.isRunning = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }
    
    // Wait for running jobs to complete with timeout
    const maxWaitTime = 10000; // 10 seconds max wait
    const startTime = Date.now();
    
    while (this.runningJobsCount > 0 && (Date.now() - startTime) < maxWaitTime) {
      console.log(`Waiting for ${this.runningJobsCount} jobs to complete...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (this.runningJobsCount > 0) {
      console.log(`Warning: ${this.runningJobsCount} jobs still running after timeout, forcing shutdown`);
      this.runningJobsCount = 0; // Force reset
    }
    
    console.log('JobManager stopped');
  }

  private async processJobs(): Promise<void> {
    if (!this.isRunning) return;
    
    const availableSlots = this.concurrency - this.runningJobsCount;
    if (availableSlots <= 0) return;
    
    console.log(`Processing jobs: ${this.runningJobsCount} running, ${availableSlots} slots available (max: ${this.concurrency})`);
    
    for (let i = 0; i < availableSlots; i++) {
      const job = this.db.getNextJob();
      if (!job) break;
      
      this.runningJobsCount++;
      console.log(`Starting job ${job.id} (slot ${this.runningJobsCount}/${this.concurrency})`);
      
      // Process job asynchronously
      this.processJob(job.id).finally(() => {
        this.runningJobsCount--;
      });
    }
  }

  private async processJob(jobId: number): Promise<void> {
    console.log(`Processing job ${jobId} (podcast-processing) - Running jobs: ${this.runningJobsCount}/${this.concurrency}`);
    
    try {
      // Check if we should stop
      if (!this.isRunning) {
        console.log(`Job ${jobId} cancelled - JobManager is stopping`);
        return;
      }
      
      // Mark job as processing
      this.db.updateJobStatus(jobId, 'processing');
      
      // Get job details
      const job = this.db.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }
      
      // Get episode details
      const episode = this.db.getEpisode(job.episodeGuid);
      if (!episode) {
        throw new Error(`Episode ${job.episodeGuid} not found`);
      }
      
      console.log(`🎙️  Processing episode: "${episode.title}"`);
      console.log(`📊 Episode Details:`);
      console.log(`   • Show: ${episode.showId}`);
      console.log(`   • GUID: ${episode.guid}`);
      console.log(`   • Duration: ${Math.floor(episode.duration / 60)}m ${episode.duration % 60}s`);
      console.log(`   • Published: ${episode.publishDate.toLocaleDateString()}`);
      console.log(`   • Audio URL: ${episode.audioUrl}`);
      
      // Process the episode
      const result = await this.podcastWorker.process({
        podcastId: episode.showId,
        episodeId: episode.guid,
        audioUrl: episode.audioUrl,
        minAdDuration: this.processingConfig.minAdDuration,
        episodeTitle: episode.title,
        duration: episode.duration,
        jobId: jobId
      });
      
      // Save results
      await this.saveProcessingResult(jobId, result);
      
      // Mark job as completed
      this.db.updateJobStatus(jobId, 'completed');
      
      console.log(`✅ Episode processing completed: "${episode.title}"`);
      
    } catch (error) {
      // If we're shutting down, mark job as pending so it can be retried later
      if (!this.isRunning) {
        this.db.updateJobStatus(jobId, 'pending');
        console.log(`Job ${jobId} reset to pending due to shutdown`);
      } else {
        console.error(`❌ Processing error for job ${jobId}:`, formatError(error));
        this.db.updateJobStatus(jobId, 'failed', formatError(error));
      }
    }
  }

  private async saveProcessingResult(jobId: number, result: ProcessingResult): Promise<void> {
    // Save processed episode
    this.db.saveProcessedEpisode(
      jobId,
      result.processedUrl,
      result.originalDuration,
      result.processedDuration,
      result.processingCost
    );
    
    // Save chapters
    if (result.chapters && result.chapters.length > 0) {
      this.db.saveChapters(jobId, result.chapters);
    }
    
    // Save ads
    if (result.adsRemoved && result.adsRemoved.length > 0) {
      this.db.saveAds(jobId, result.adsRemoved);
    }
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      runningJobs: this.runningJobsCount,
      maxConcurrency: this.concurrency,
      jobStats: this.db.getJobStats()
    };
  }
}