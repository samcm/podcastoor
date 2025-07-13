import Database from 'better-sqlite3';
import { ProcessingResult } from '@podcastoor/shared';

export interface JobConfig {
  dbPath: string;
  concurrency: number;
  retryAttempts: number;
  processingTimeoutMs: number;
}

export interface PodcastJobData {
  podcastId: string;
  episodeId: string;
  audioUrl: string;
}

export interface CleanupJobData {
  olderThanDays: number;
  dryRun: boolean;
}

export interface JobStatus {
  id: number;
  type: string;
  data: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
}

export class JobManager {
  private db: Database.Database;
  private config: JobConfig;
  private workers: Worker[] = [];
  private isRunning: boolean = false;
  private processingInterval?: NodeJS.Timeout;

  constructor(config: JobConfig) {
    this.config = config;
    this.db = new Database(config.dbPath);
    this.initializeDatabase();
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

    // Stop processing loop
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    // Wait for running jobs to complete (with timeout)
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds timeout
    
    while (this.getRunningJobsCount() > 0 && attempts < maxAttempts) {
      console.log(`Waiting for ${this.getRunningJobsCount()} jobs to complete...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    // Force cleanup any still-running jobs
    this.markStuckJobsAsFailed();

    this.db.close();
    console.log('JobManager stopped');
  }

  async addPodcastProcessingJob(
    podcastId: string,
    episodeId: string,
    audioUrl: string,
    priority: number = 0
  ): Promise<number> {
    const jobData: PodcastJobData = {
      podcastId,
      episodeId,
      audioUrl
    };

    const stmt = this.db.prepare(`
      INSERT INTO jobs (type, data, priority, status, attempts, created_at)
      VALUES (?, ?, ?, 'pending', 0, datetime('now'))
    `);

    const result = stmt.run('podcast-processing', JSON.stringify(jobData), priority);
    const jobId = result.lastInsertRowid as number;

    console.log(`Added podcast processing job: ${podcastId}/${episodeId} (ID: ${jobId})`);
    return jobId;
  }

  async addCleanupJob(olderThanDays: number, dryRun: boolean = false): Promise<number> {
    const jobData: CleanupJobData = {
      olderThanDays,
      dryRun
    };

    const stmt = this.db.prepare(`
      INSERT INTO jobs (type, data, status, attempts, created_at)
      VALUES (?, ?, 'pending', 0, datetime('now'))
    `);

    const result = stmt.run('cleanup', JSON.stringify(jobData));
    const jobId = result.lastInsertRowid as number;

    console.log(`Added cleanup job: ${olderThanDays} days${dryRun ? ' (dry run)' : ''} (ID: ${jobId})`);
    return jobId;
  }

  async getJobStatus(jobId: number): Promise<JobStatus | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs WHERE id = ?
    `);

    const row = stmt.get(jobId) as any;
    if (!row) return null;

    return this.mapRowToJobStatus(row);
  }

  async retryFailedJobs(): Promise<number> {
    console.log('Retrying failed jobs...');

    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'pending', attempts = 0, last_error = NULL, started_at = NULL
      WHERE status = 'failed' AND attempts < ?
    `);

    const result = stmt.run(this.config.retryAttempts);
    const retriedCount = result.changes;

    console.log(`Retried ${retriedCount} failed jobs`);
    return retriedCount;
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM jobs 
      GROUP BY status
    `);

    const rows = stmt.all() as Array<{ status: string; count: number }>;
    const stats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    };

    rows.forEach(row => {
      switch (row.status) {
        case 'pending':
          stats.waiting = row.count;
          break;
        case 'running':
          stats.active = row.count;
          break;
        case 'completed':
          stats.completed = row.count;
          break;
        case 'failed':
          stats.failed = row.count;
          break;
      }
    });

    return stats;
  }

  private initializeDatabase(): void {
    // Create jobs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT
      )
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
    `);

    console.log('Database initialized');
  }

  private async processJobs(): Promise<void> {
    if (!this.isRunning) return;

    const runningJobs = this.getRunningJobsCount();
    const availableSlots = this.config.concurrency - runningJobs;

    if (availableSlots <= 0) return;

    // Get pending jobs ordered by priority and creation time
    const stmt = this.db.prepare(`
      SELECT * FROM jobs 
      WHERE status = 'pending' AND attempts < ?
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `);

    const pendingJobs = stmt.all(this.config.retryAttempts, availableSlots) as any[];

    for (const job of pendingJobs) {
      this.processJob(job);
    }
  }

  private async processJob(job: any): Promise<void> {
    const jobId = job.id;
    
    try {
      // Mark job as running
      const updateStmt = this.db.prepare(`
        UPDATE jobs 
        SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
        WHERE id = ? AND status = 'pending'
      `);
      
      const updateResult = updateStmt.run(jobId);
      if (updateResult.changes === 0) {
        // Job was already picked up by another worker
        return;
      }

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

      // Mark job as completed
      const completeStmt = this.db.prepare(`
        UPDATE jobs 
        SET status = 'completed', completed_at = datetime('now'), result = ?
        WHERE id = ?
      `);
      
      completeStmt.run(JSON.stringify(result), jobId);
      console.log(`Job ${jobId} completed successfully`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Job ${jobId} failed:`, errorMessage);

      // Mark job as failed
      const failStmt = this.db.prepare(`
        UPDATE jobs 
        SET status = 'failed', last_error = ?, completed_at = datetime('now')
        WHERE id = ?
      `);
      
      failStmt.run(errorMessage, jobId);
    }
  }

  private async processPodcastJob(data: PodcastJobData): Promise<ProcessingResult> {
    // This would integrate with actual processing services
    // For now, return a mock result
    console.log(`Processing podcast: ${data.podcastId}/${data.episodeId}`);
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 1000));

    return {
      podcastId: data.podcastId,
      episodeId: data.episodeId,
      originalUrl: data.audioUrl,
      processedUrl: `https://storage.example.com/processed/${data.podcastId}/${data.episodeId}.mp3`,
      adsRemoved: [],
      chapters: [],
      processingCost: 0.05,
      processedAt: new Date()
    };
  }

  private async processCleanupJob(data: CleanupJobData): Promise<{ deletedCount: number; dryRun: boolean }> {
    console.log(`Processing cleanup: ${data.olderThanDays} days${data.dryRun ? ' (dry run)' : ''}`);
    
    // Simulate cleanup time
    await new Promise(resolve => setTimeout(resolve, 500));

    return {
      deletedCount: data.dryRun ? 0 : Math.floor(Math.random() * 10),
      dryRun: data.dryRun
    };
  }

  private getRunningJobsCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM jobs WHERE status = 'running'
    `);
    
    const result = stmt.get() as { count: number };
    return result.count;
  }

  private markStuckJobsAsFailed(): void {
    // Mark jobs that have been running for too long as failed
    const timeoutMinutes = this.config.processingTimeoutMs / (1000 * 60);
    
    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'failed', last_error = 'Job timed out', completed_at = datetime('now')
      WHERE status = 'running' 
      AND datetime(started_at, '+${timeoutMinutes} minutes') < datetime('now')
    `);
    
    const result = stmt.run();
    if (result.changes > 0) {
      console.log(`Marked ${result.changes} stuck jobs as failed`);
    }
  }

  private mapRowToJobStatus(row: any): JobStatus {
    return {
      id: row.id,
      type: row.type,
      data: row.data,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      result: row.result
    };
  }
}