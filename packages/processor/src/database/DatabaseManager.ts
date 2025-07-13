import Database from 'better-sqlite3';
import { ProcessingResult, Episode, AdDetection, Chapter } from '@podcastoor/shared';

export interface DatabaseConfig {
  dbPath: string;
}

export interface StoredEpisode {
  id: number;
  podcastId: string;
  episodeGuid: string;
  title: string;
  description: string;
  audioUrl: string;
  publishDate: Date;
  duration: number;
  status: 'discovered' | 'processing' | 'completed' | 'failed';
  processedAt?: Date;
  processedUrl?: string;
  processingCost?: number;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredJob {
  id: number;
  type: string;
  data: string;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
}

export interface PodcastState {
  podcastId: string;
  lastProcessed: Date;
  lastRSSFetch: Date;
  totalEpisodes: number;
  processedEpisodes: number;
  updatedAt: Date;
}

export interface PodcastInfo {
  id: string;
  title: string;
  description?: string;
  feedUrl: string;
  lastProcessed?: Date;
  lastRSSFetch?: Date;
  totalEpisodes: number;
  processedEpisodes: number;
}

export class DatabaseManager {
  private db: Database.Database;

  constructor(config: DatabaseConfig) {
    this.db = new Database(config.dbPath);
    this.initializeTables();
  }

  // ========== EPISODE MANAGEMENT ==========

  async upsertEpisode(podcastId: string, episode: Episode): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO episodes (
        podcast_id, episode_guid, title, description, audio_url, 
        publish_date, duration, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', datetime('now'), datetime('now'))
      ON CONFLICT(podcast_id, episode_guid) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        audio_url = excluded.audio_url,
        publish_date = excluded.publish_date,
        duration = excluded.duration,
        updated_at = datetime('now')
      WHERE status = 'discovered'  -- Only update if not processed
    `);

    const result = stmt.run(
      podcastId,
      episode.guid,
      episode.title,
      episode.description,
      episode.audioUrl,
      episode.publishDate.toISOString(),
      episode.duration
    );

    // If lastInsertRowid is 0, it means the episode already existed (conflict occurred)
    // We need to fetch the existing episode ID
    if (result.lastInsertRowid === 0) {
      const selectStmt = this.db.prepare(`
        SELECT id FROM episodes 
        WHERE podcast_id = ? AND episode_guid = ?
      `);
      const existingRow = selectStmt.get(podcastId, episode.guid) as { id: number } | undefined;
      
      if (!existingRow) {
        throw new Error(`Failed to find episode after upsert: ${podcastId}/${episode.guid}`);
      }
      
      return existingRow.id;
    }

    return result.lastInsertRowid as number;
  }

  async getEpisodeById(episodeId: number): Promise<StoredEpisode | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM episodes 
      WHERE id = ?
    `);

    const row = stmt.get(episodeId) as any;
    return row ? this.mapRowToEpisode(row) : null;
  }

  async getEpisodesByPodcast(podcastId: string, status?: string): Promise<StoredEpisode[]> {
    let query = `
      SELECT * FROM episodes 
      WHERE podcast_id = ?
    `;
    const params: any[] = [podcastId];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY publish_date DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    
    return rows.map(this.mapRowToEpisode);
  }

  async getUnprocessedEpisodes(podcastId?: string): Promise<StoredEpisode[]> {
    let query = `
      SELECT * FROM episodes 
      WHERE status = 'discovered'
    `;
    const params: any[] = [];

    if (podcastId) {
      query += ` AND podcast_id = ?`;
      params.push(podcastId);
    }

    query += ` ORDER BY publish_date ASC`;  // Process oldest first

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    
    return rows.map(this.mapRowToEpisode);
  }

  async markEpisodeProcessing(episodeId: number): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE episodes 
      SET status = 'processing', updated_at = datetime('now')
      WHERE id = ? AND status = 'discovered'
    `);

    const result = stmt.run(episodeId);
    return result.changes > 0;
  }

  async markEpisodeCompleted(episodeId: number, processingResult: ProcessingResult): Promise<void> {
    // Store processing result
    await this.storeProcessingResult(processingResult);

    // Update episode
    const stmt = this.db.prepare(`
      UPDATE episodes 
      SET 
        status = 'completed',
        processed_at = datetime('now'),
        processed_url = ?,
        processing_cost = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(
      processingResult.processedUrl,
      processingResult.processingCost,
      episodeId
    );
  }

  async markEpisodeFailed(episodeId: number, error: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE episodes 
      SET 
        status = 'failed',
        failure_reason = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(error, episodeId);
  }

  async isEpisodeProcessed(podcastId: string, episodeGuid: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM episodes 
      WHERE podcast_id = ? AND episode_guid = ? AND status = 'completed'
    `);

    const result = stmt.get(podcastId, episodeGuid) as { count: number };
    return result.count > 0;
  }

  // ========== PROCESSING RESULTS ==========

  async storeProcessingResult(result: ProcessingResult): Promise<number> {
    const resultStmt = this.db.prepare(`
      INSERT INTO processing_results (
        podcast_id, episode_id, original_url, processed_url,
        processing_cost, processed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const resultId = resultStmt.run(
      result.podcastId,
      result.episodeId,
      result.originalUrl,
      result.processedUrl,
      result.processingCost,
      result.processedAt.toISOString()
    ).lastInsertRowid as number;

    // Store ad detections
    if (result.adsRemoved.length > 0) {
      const adStmt = this.db.prepare(`
        INSERT INTO ad_detections (
          result_id, start_time, end_time, confidence, ad_type, description
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const ad of result.adsRemoved) {
        adStmt.run(resultId, ad.startTime, ad.endTime, ad.confidence, ad.adType, ad.description);
      }
    }

    // Store chapters
    if (result.chapters.length > 0) {
      const chapterStmt = this.db.prepare(`
        INSERT INTO chapters (
          result_id, title, start_time, end_time, description
        ) VALUES (?, ?, ?, ?, ?)
      `);

      for (const chapter of result.chapters) {
        chapterStmt.run(resultId, chapter.title, chapter.startTime, chapter.endTime, chapter.description);
      }
    }

    return resultId;
  }

  async getProcessingResults(podcastId: string): Promise<ProcessingResult[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM processing_results 
      WHERE podcast_id = ?
      ORDER BY processed_at DESC
    `);

    const rows = stmt.all(podcastId) as any[];
    const results: ProcessingResult[] = [];

    for (const row of rows) {
      const adsRemoved = await this.getAdDetections(row.id);
      const chapters = await this.getChapters(row.id);

      results.push({
        podcastId: row.podcast_id,
        episodeId: row.episode_id,
        originalUrl: row.original_url,
        processedUrl: row.processed_url,
        adsRemoved,
        chapters,
        processingCost: row.processing_cost,
        processedAt: new Date(row.processed_at)
      });
    }

    return results;
  }

  private async getAdDetections(resultId: number): Promise<AdDetection[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM ad_detections WHERE result_id = ? ORDER BY start_time
    `);

    const rows = stmt.all(resultId) as any[];
    return rows.map(row => ({
      startTime: row.start_time,
      endTime: row.end_time,
      confidence: row.confidence,
      adType: row.ad_type,
      description: row.description
    }));
  }

  private async getChapters(resultId: number): Promise<Chapter[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM chapters WHERE result_id = ? ORDER BY start_time
    `);

    const rows = stmt.all(resultId) as any[];
    return rows.map(row => ({
      title: row.title,
      startTime: row.start_time,
      endTime: row.end_time,
      description: row.description
    }));
  }

  // ========== PODCAST STATE ==========

  async savePodcast(podcastId: string, title: string, description: string | undefined, feedUrl: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO podcasts (podcast_id, title, description, feed_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(podcast_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        feed_url = excluded.feed_url,
        updated_at = datetime('now')
    `);

    stmt.run(podcastId, title, description || null, feedUrl);
  }

  async updatePodcastState(podcastId: string, updates: Partial<PodcastState>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO podcast_state (
        podcast_id, last_processed, last_rss_fetch, total_episodes, 
        processed_episodes, updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(podcast_id) DO UPDATE SET
        last_processed = COALESCE(excluded.last_processed, last_processed),
        last_rss_fetch = COALESCE(excluded.last_rss_fetch, last_rss_fetch),
        total_episodes = COALESCE(excluded.total_episodes, total_episodes),
        processed_episodes = COALESCE(excluded.processed_episodes, processed_episodes),
        updated_at = datetime('now')
    `);

    stmt.run(
      podcastId,
      updates.lastProcessed?.toISOString(),
      updates.lastRSSFetch?.toISOString(),
      updates.totalEpisodes,
      updates.processedEpisodes
    );
  }

  async getPodcastState(podcastId: string): Promise<PodcastState | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM podcast_state WHERE podcast_id = ?
    `);

    const row = stmt.get(podcastId) as any;
    if (!row) return null;

    return {
      podcastId: row.podcast_id,
      lastProcessed: new Date(row.last_processed),
      lastRSSFetch: new Date(row.last_rss_fetch),
      totalEpisodes: row.total_episodes,
      processedEpisodes: row.processed_episodes,
      updatedAt: new Date(row.updated_at)
    };
  }

  getAllPodcasts(): PodcastInfo[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT 
        p.podcast_id as id,
        p.title,
        p.description,
        p.feed_url,
        ps.last_processed,
        ps.last_rss_fetch,
        ps.total_episodes,
        ps.processed_episodes
      FROM podcasts p
      LEFT JOIN podcast_state ps ON p.podcast_id = ps.podcast_id
      ORDER BY p.created_at DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      feedUrl: row.feed_url,
      lastProcessed: row.last_processed ? new Date(row.last_processed) : undefined,
      lastRSSFetch: row.last_rss_fetch ? new Date(row.last_rss_fetch) : undefined,
      totalEpisodes: row.total_episodes || 0,
      processedEpisodes: row.processed_episodes || 0
    }));
  }

  async getRecentlyProcessedEpisodes(limit: number = 20): Promise<StoredEpisode[]> {
    const stmt = this.db.prepare(`
      SELECT e.*, p.title as podcast_title
      FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.podcast_id
      WHERE e.status = 'completed' AND e.processed_at IS NOT NULL
      ORDER BY e.processed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map(row => ({
      ...this.mapRowToEpisode(row),
      podcastTitle: row.podcast_title
    }));
  }

  async getEpisodeByGuid(podcastId: string, episodeGuid: string): Promise<StoredEpisode | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM episodes 
      WHERE podcast_id = ? AND episode_guid = ?
    `);

    const row = stmt.get(podcastId, episodeGuid) as any;
    return row ? this.mapRowToEpisode(row) : null;
  }

  async getPodcastStats(podcastId: string): Promise<{
    totalAdsRemoved: number;
    totalCost: number;
    totalDuration: number;
    averageAdsPerEpisode: number;
  }> {
    // Get total ads removed
    const adsStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM ad_detections ad
      JOIN processing_results pr ON ad.result_id = pr.id
      WHERE pr.podcast_id = ?
    `);
    const adsResult = adsStmt.get(podcastId) as any;

    // Get total cost and episode count
    const costStmt = this.db.prepare(`
      SELECT 
        SUM(processing_cost) as total_cost,
        COUNT(*) as episode_count,
        SUM(duration) as total_duration
      FROM episodes
      WHERE podcast_id = ? AND status = 'completed'
    `);
    const costResult = costStmt.get(podcastId) as any;

    return {
      totalAdsRemoved: adsResult?.count || 0,
      totalCost: costResult?.total_cost || 0,
      totalDuration: costResult?.total_duration || 0,
      averageAdsPerEpisode: costResult?.episode_count > 0 
        ? (adsResult?.count || 0) / costResult.episode_count 
        : 0
    };
  }

  getPodcast(podcastId: string): PodcastInfo | null {
    const stmt = this.db.prepare(`
      SELECT DISTINCT 
        p.podcast_id as id,
        p.title,
        p.description,
        p.feed_url,
        ps.last_processed,
        ps.last_rss_fetch,
        ps.total_episodes,
        ps.processed_episodes
      FROM podcasts p
      LEFT JOIN podcast_state ps ON p.podcast_id = ps.podcast_id
      WHERE p.podcast_id = ?
    `);

    const row = stmt.get(podcastId) as any;
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      feedUrl: row.feed_url,
      lastProcessed: row.last_processed ? new Date(row.last_processed) : undefined,
      lastRSSFetch: row.last_rss_fetch ? new Date(row.last_rss_fetch) : undefined,
      totalEpisodes: row.total_episodes || 0,
      processedEpisodes: row.processed_episodes || 0
    };
  }

  // ========== JOB MANAGEMENT ==========

  async createJob(type: string, data: any, priority: number = 0): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (type, data, priority, status, attempts, created_at)
      VALUES (?, ?, ?, 'pending', 0, datetime('now'))
    `);

    const result = stmt.run(type, JSON.stringify(data), priority);
    return result.lastInsertRowid as number;
  }

  async getNextJob(): Promise<StoredJob | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs 
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `);

    const row = stmt.get() as any;
    return row ? this.mapRowToJob(row) : null;
  }

  async markJobRunning(jobId: number): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
      WHERE id = ? AND status = 'pending'
    `);

    const result = stmt.run(jobId);
    return result.changes > 0;
  }

  async markJobCompleted(jobId: number, result?: any): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'completed', completed_at = datetime('now'), result = ?
      WHERE id = ?
    `);

    stmt.run(result ? JSON.stringify(result) : null, jobId);
  }

  async markJobFailed(jobId: number, error: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'failed', last_error = ?, completed_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(error, jobId);
  }

  async getJobStats(): Promise<{ waiting: number; active: number; completed: number; failed: number }> {
    const stmt = this.db.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM jobs 
      GROUP BY status
    `);

    const rows = stmt.all() as Array<{ status: string; count: number }>;
    const stats = { waiting: 0, active: 0, completed: 0, failed: 0 };

    rows.forEach(row => {
      switch (row.status) {
        case 'pending': stats.waiting = row.count; break;
        case 'running': stats.active = row.count; break;
        case 'completed': stats.completed = row.count; break;
        case 'failed': stats.failed = row.count; break;
      }
    });

    return stats;
  }

  // ========== UTILITY METHODS ==========

  private initializeTables(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      
      CREATE TABLE IF NOT EXISTS podcasts (
        podcast_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        feed_url TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        podcast_id TEXT NOT NULL,
        episode_guid TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        audio_url TEXT NOT NULL,
        publish_date TEXT NOT NULL,
        duration INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'discovered',
        processed_at TEXT,
        processed_url TEXT,
        processing_cost REAL,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(podcast_id, episode_guid),
        FOREIGN KEY(podcast_id) REFERENCES podcasts(podcast_id)
      );

      CREATE TABLE IF NOT EXISTS processing_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        podcast_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        original_url TEXT NOT NULL,
        processed_url TEXT NOT NULL,
        processing_cost REAL DEFAULT 0,
        processed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ad_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id INTEGER NOT NULL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        confidence REAL NOT NULL,
        ad_type TEXT NOT NULL,
        description TEXT,
        FOREIGN KEY(result_id) REFERENCES processing_results(id)
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        description TEXT,
        FOREIGN KEY(result_id) REFERENCES processing_results(id)
      );

      CREATE TABLE IF NOT EXISTS podcast_state (
        podcast_id TEXT PRIMARY KEY,
        last_processed TEXT,
        last_rss_fetch TEXT,
        total_episodes INTEGER DEFAULT 0,
        processed_episodes INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );

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
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_podcast_status ON episodes(podcast_id, status);
      CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON jobs(status, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS idx_processing_results_podcast ON processing_results(podcast_id);
    `);

    console.log('Database tables initialized');
  }

  private mapRowToEpisode(row: any): StoredEpisode {
    return {
      id: row.id,
      podcastId: row.podcast_id,
      episodeGuid: row.episode_guid,
      title: row.title,
      description: row.description,
      audioUrl: row.audio_url,
      publishDate: new Date(row.publish_date),
      duration: row.duration,
      status: row.status,
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
      processedUrl: row.processed_url,
      processingCost: row.processing_cost,
      failureReason: row.failure_reason,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private mapRowToJob(row: any): StoredJob {
    return {
      id: row.id,
      type: row.type,
      data: row.data,
      priority: row.priority,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      result: row.result
    };
  }

  close(): void {
    this.db.close();
  }
}