import BetterSqlite3 from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync, readFileSync } from 'fs';
import type { AdDetection, Chapter } from '@podcastoor/shared';

export interface DatabaseConfig {
  path: string;
}

export interface Episode {
  guid: string;
  showId: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
}

export interface Show {
  id: string;
  title: string;
  description?: string;
  feedUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  id: number;
  episodeGuid: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  priority: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProcessedEpisode {
  jobId: number;
  processedUrl: string;
  originalDuration: number;
  processedDuration: number;
  processingCost?: number;
  createdAt: Date;
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(config: DatabaseConfig) {
    // Ensure database directory exists
    const dbDir = dirname(config.path);
    mkdirSync(dbDir, { recursive: true });
    
    this.db = new BetterSqlite3(config.path);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Read and execute the schema
    const schemaPath = join(dirname(__filename), 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    
    // Disable foreign keys during schema creation
    this.db.exec('PRAGMA foreign_keys = OFF');
    
    try {
      this.db.exec(schema);
    } catch (error) {
      console.error('Error creating tables:', error);
      throw error;
    }

    // Re-enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  // ========== SHOWS ==========

  upsertShow(id: string, title: string, description: string | undefined, feedUrl: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO shows (id, title, description, feed_url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        feed_url = excluded.feed_url,
        updated_at = datetime('now')
    `);
    stmt.run(id, title, description || null, feedUrl);
  }

  getShow(id: string): Show | null {
    const stmt = this.db.prepare('SELECT * FROM shows WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      feedUrl: row.feed_url,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  getAllShows(): Show[] {
    const stmt = this.db.prepare('SELECT * FROM shows ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      feedUrl: row.feed_url,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  // ========== EPISODES ==========

  upsertEpisode(episode: Episode): void {
    const stmt = this.db.prepare(`
      INSERT INTO episodes (guid, show_id, title, description, audio_url, publish_date, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guid) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        audio_url = excluded.audio_url
    `);
    stmt.run(
      episode.guid,
      episode.showId,
      episode.title,
      episode.description,
      episode.audioUrl,
      episode.publishDate.toISOString(),
      episode.duration
    );
  }

  getEpisode(guid: string): Episode | null {
    const stmt = this.db.prepare('SELECT * FROM episodes WHERE guid = ?');
    const row = stmt.get(guid) as any;
    if (!row) return null;
    
    return {
      guid: row.guid,
      showId: row.show_id,
      title: row.title,
      description: row.description,
      audioUrl: row.audio_url,
      publishDate: new Date(row.publish_date),
      duration: row.duration
    };
  }

  getShowEpisodes(showId: string, limit?: number): Episode[] {
    const query = limit 
      ? 'SELECT * FROM episodes WHERE show_id = ? ORDER BY publish_date DESC LIMIT ?'
      : 'SELECT * FROM episodes WHERE show_id = ? ORDER BY publish_date DESC';
    
    const stmt = this.db.prepare(query);
    const rows = limit ? stmt.all(showId, limit) : stmt.all(showId);
    
    return (rows as any[]).map(row => ({
      guid: row.guid,
      showId: row.show_id,
      title: row.title,
      description: row.description,
      audioUrl: row.audio_url,
      publishDate: new Date(row.publish_date),
      duration: row.duration
    }));
  }

  getRecentEpisodes(limit: number = 20): Episode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM episodes 
      ORDER BY publish_date DESC 
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    
    return rows.map(row => ({
      guid: row.guid,
      showId: row.show_id,
      title: row.title,
      description: row.description,
      audioUrl: row.audio_url,
      publishDate: new Date(row.publish_date),
      duration: row.duration
    }));
  }

  // ========== JOBS ==========

  createJob(episodeGuid: string, priority: number = 0): number {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (episode_guid, priority)
      VALUES (?, ?)
    `);
    const result = stmt.run(episodeGuid, priority);
    return result.lastInsertRowid as number;
  }

  getNextJob(): Job | null {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs 
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `);
    const row = stmt.get() as any;
    if (!row) return null;
    
    return this.mapJob(row);
  }

  getJob(id: number): Job | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    
    return this.mapJob(row);
  }

  getEpisodeJobs(episodeGuid: string): Job[] {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs 
      WHERE episode_guid = ? 
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(episodeGuid) as any[];
    
    return rows.map(row => this.mapJob(row));
  }

  updateJobStatus(id: number, status: Job['status'], error?: string): void {
    const now = new Date().toISOString();
    
    if (status === 'processing') {
      const stmt = this.db.prepare(`
        UPDATE jobs 
        SET status = ?, started_at = ?
        WHERE id = ?
      `);
      stmt.run(status, now, id);
    } else if (status === 'completed' || status === 'failed') {
      const stmt = this.db.prepare(`
        UPDATE jobs 
        SET status = ?, completed_at = ?, error = ?
        WHERE id = ?
      `);
      stmt.run(status, now, error || null, id);
    }
  }

  getJobStats(): { pending: number; processing: number; completed: number; failed: number } {
    const stmt = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM jobs
      GROUP BY status
    `);
    const rows = stmt.all() as Array<{ status: string; count: number }>;
    
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
    rows.forEach(row => {
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = row.count;
      }
    });
    
    return stats;
  }

  // ========== PROCESSED EPISODES ==========

  saveProcessedEpisode(jobId: number, processedUrl: string, originalDuration: number, processedDuration: number, cost?: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO processed_episodes (job_id, processed_url, original_duration, processed_duration, processing_cost)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(jobId, processedUrl, originalDuration, processedDuration, cost || null);
  }

  getProcessedEpisode(jobId: number): ProcessedEpisode | null {
    const stmt = this.db.prepare('SELECT * FROM processed_episodes WHERE job_id = ?');
    const row = stmt.get(jobId) as any;
    if (!row) return null;
    
    return {
      jobId: row.job_id,
      processedUrl: row.processed_url,
      originalDuration: row.original_duration,
      processedDuration: row.processed_duration,
      processingCost: row.processing_cost,
      createdAt: new Date(row.created_at)
    };
  }

  // ========== CHAPTERS ==========

  saveChapters(jobId: number, chapters: Chapter[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO chapters (job_id, title, start_time, end_time, summary)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((chapters: Chapter[]) => {
      for (const chapter of chapters) {
        stmt.run(jobId, chapter.title, chapter.startTime, chapter.endTime, chapter.description);
      }
    });
    
    insertMany(chapters);
  }

  getChapters(jobId: number): Chapter[] {
    const stmt = this.db.prepare('SELECT * FROM chapters WHERE job_id = ? ORDER BY start_time');
    const rows = stmt.all(jobId) as any[];
    
    return rows.map(row => ({
      title: row.title,
      startTime: row.start_time,
      endTime: row.end_time,
      description: row.summary
    }));
  }

  // ========== ADS ==========

  saveAds(jobId: number, ads: AdDetection[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO ads (job_id, start_time, end_time, confidence, type)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((ads: AdDetection[]) => {
      for (const ad of ads) {
        // Map 'embedded' to 'unknown' since database doesn't support 'embedded'
        const adType = ad.adType === 'embedded' ? 'unknown' : (ad.adType || 'unknown');
        stmt.run(jobId, ad.startTime, ad.endTime, ad.confidence, adType);
      }
    });
    
    insertMany(ads);
  }

  getAds(jobId: number): AdDetection[] {
    const stmt = this.db.prepare('SELECT * FROM ads WHERE job_id = ? ORDER BY start_time');
    const rows = stmt.all(jobId) as any[];
    
    return rows.map(row => ({
      startTime: row.start_time,
      endTime: row.end_time,
      confidence: row.confidence,
      adType: row.type !== 'unknown' ? row.type : undefined,
      description: ''
    }));
  }

  // ========== COMPLEX QUERIES ==========

  getEpisodeDetails(episodeGuid: string) {
    const episode = this.getEpisode(episodeGuid);
    if (!episode) return null;

    const jobs = this.getEpisodeJobs(episodeGuid);
    
    // Find the most recent completed job, or fall back to the most recent job
    let selectedJob = jobs.find(job => job.status === 'completed') || jobs[0];
    
    if (!selectedJob) {
      return { episode, job: null, processedEpisode: null, chapters: [], ads: [] };
    }

    const processedEpisode = this.getProcessedEpisode(selectedJob.id);
    const chapters = selectedJob.status === 'completed' ? this.getChapters(selectedJob.id) : [];
    const ads = selectedJob.status === 'completed' ? this.getAds(selectedJob.id) : [];

    return { episode, job: selectedJob, processedEpisode, chapters, ads };
  }

  getShowStats(showId: string) {
    // Get episode count
    const episodeCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM episodes WHERE show_id = ?');
    const episodeCount = (episodeCountStmt.get(showId) as any).count;

    // Get processed count
    const processedCountStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT e.guid) as count 
      FROM episodes e
      JOIN jobs j ON e.guid = j.episode_guid
      WHERE e.show_id = ? AND j.status = 'completed'
    `);
    const processedCount = (processedCountStmt.get(showId) as any).count;

    // Get total ads removed
    const adsRemovedStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM episodes e
      JOIN jobs j ON e.guid = j.episode_guid
      JOIN ads a ON j.id = a.job_id
      WHERE e.show_id = ?
    `);
    const totalAdsRemoved = (adsRemovedStmt.get(showId) as any).count;

    // Get total time saved
    const timeSavedStmt = this.db.prepare(`
      SELECT COALESCE(SUM(a.end_time - a.start_time), 0) as time_saved
      FROM episodes e
      JOIN jobs j ON e.guid = j.episode_guid
      JOIN ads a ON j.id = a.job_id
      WHERE e.show_id = ?
    `);
    const totalTimeSaved = (timeSavedStmt.get(showId) as any).time_saved;

    return {
      episodeCount,
      processedCount,
      totalAdsRemoved,
      totalTimeSaved,
      averageAdsPerEpisode: processedCount > 0 ? totalAdsRemoved / processedCount : 0
    };
  }

  // ========== UTILITY ==========

  private mapJob(row: any): Job {
    return {
      id: row.id,
      episodeGuid: row.episode_guid,
      status: row.status,
      error: row.error,
      priority: row.priority,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined
    };
  }

  close(): void {
    this.db.close();
  }
}