import Database from 'better-sqlite3';
import { UpstreamEpisode, ProcessingJob, LLMCost, Chapter, AdRemoval } from '@podcastoor/shared';
import type { ProcessingResult } from '@podcastoor/shared';

export class DatabaseService {
  constructor(private db: Database.Database) {}
  
  // Upstream episodes methods
  async insertUpstreamEpisode(episode: Omit<UpstreamEpisode, 'id' | 'importedAt'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO upstream_episodes (podcast_id, episode_guid, title, description, audio_url, publish_date, duration, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(podcast_id, episode_guid) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        audio_url = excluded.audio_url
    `);
    const result = stmt.run(
      episode.podcastId,
      episode.episodeGuid,
      episode.title,
      episode.description,
      episode.audioUrl,
      episode.publishDate.toISOString(),
      episode.duration,
      episode.fileSize
    );
    return result.lastInsertRowid as number;
  }
  
  async getUnprocessedEpisodes(podcastId: string, limit: number): Promise<UpstreamEpisode[]> {
    const stmt = this.db.prepare(`
      SELECT u.* FROM upstream_episodes u
      LEFT JOIN processing_jobs j ON u.episode_guid = j.episode_guid AND u.podcast_id = j.podcast_id
      WHERE u.podcast_id = ? AND j.id IS NULL
      ORDER BY u.publish_date DESC
      LIMIT ?
    `);
    return stmt.all(podcastId, limit) as UpstreamEpisode[];
  }

  async getUpstreamEpisode(episodeGuid: string, podcastId: string): Promise<UpstreamEpisode | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM upstream_episodes 
      WHERE episode_guid = ? AND podcast_id = ?
    `);
    return stmt.get(episodeGuid, podcastId) as UpstreamEpisode | null;
  }

  async getUpstreamEpisodeByGuid(episodeGuid: string): Promise<UpstreamEpisode | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM upstream_episodes 
      WHERE episode_guid = ?
    `);
    return stmt.get(episodeGuid) as UpstreamEpisode | null;
  }

  async getAllPodcasts(): Promise<Array<{id: string}>> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT podcast_id as id FROM upstream_episodes
    `);
    return stmt.all() as Array<{id: string}>;
  }
  
  // Processing jobs methods
  async createProcessingJob(job: Omit<ProcessingJob, 'id' | 'createdAt' | 'status' | 'attempts' | 'progress'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO processing_jobs (episode_guid, podcast_id, reason, priority, is_protected)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      job.episodeGuid,
      job.podcastId,
      job.reason,
      job.priority,
      job.isProtected
    );
    return result.lastInsertRowid as number;
  }
  
  async updateJobProgress(jobId: number, progress: number, step?: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE processing_jobs 
      SET progress = ?, processing_steps = json_set(COALESCE(processing_steps, '[]'), '$[#]', json(?))
      WHERE id = ?
    `);
    const stepData = step ? JSON.stringify({ name: step, startTime: new Date() }) : null;
    stmt.run(progress, stepData, jobId);
  }

  async recordProcessingStep(jobId: number, name: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE processing_jobs 
      SET processing_steps = json_set(COALESCE(processing_steps, '[]'), '$[#]', json(?))
      WHERE id = ?
    `);
    const stepData = JSON.stringify({ name, startTime: new Date() });
    stmt.run(stepData, jobId);
  }
  
  async getNextJob(): Promise<ProcessingJob | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM processing_jobs
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `);
    return stmt.get() as ProcessingJob | null;
  }

  async getJob(jobId: number): Promise<ProcessingJob | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM processing_jobs WHERE id = ?
    `);
    return stmt.get(jobId) as ProcessingJob | null;
  }

  async getActiveJobForEpisode(episodeGuid: string): Promise<ProcessingJob | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM processing_jobs 
      WHERE episode_guid = ? AND status IN ('pending', 'running')
      LIMIT 1
    `);
    return stmt.get(episodeGuid) as ProcessingJob | null;
  }

  async resetJobStatus(jobId: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE processing_jobs 
      SET status = 'pending', attempts = 0, last_error = NULL, started_at = NULL
      WHERE id = ?
    `);
    stmt.run(jobId);
  }

  async completeJob(jobId: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE processing_jobs 
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(jobId);
  }

  async failJob(jobId: number, error: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE processing_jobs 
      SET status = 'failed', last_error = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(error, jobId);
  }

  async getEpisodesForCleanup(cutoffDate: Date): Promise<Array<{podcastId: string, episodeGuid: string}>> {
    const stmt = this.db.prepare(`
      SELECT j.podcast_id as podcastId, j.episode_guid as episodeGuid
      FROM processing_jobs j
      JOIN processing_results r ON j.id = r.job_id
      WHERE j.completed_at < ? AND j.is_protected = FALSE
    `);
    return stmt.all(cutoffDate.toISOString()) as Array<{podcastId: string, episodeGuid: string}>;
  }

  async markEpisodeCleaned(episodeGuid: string): Promise<void> {
    // Implementation would mark processed files as cleaned
    // For now, we'll just add a placeholder
    console.log(`Marked episode ${episodeGuid} as cleaned`);
  }
  
  // LLM costs methods
  async recordLLMCost(cost: Omit<LLMCost, 'id' | 'createdAt'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO llm_costs (job_id, model, operation, input_tokens, output_tokens, total_tokens, cost, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      cost.jobId,
      cost.model,
      cost.operation,
      cost.inputTokens,
      cost.outputTokens,
      cost.totalTokens,
      cost.cost,
      cost.durationMs
    );
  }
  
  async getJobCosts(jobId: number): Promise<LLMCost[]> {
    const stmt = this.db.prepare('SELECT * FROM llm_costs WHERE job_id = ?');
    return stmt.all(jobId) as LLMCost[];
  }
  
  // Chapters methods
  async insertChapters(chapters: Omit<Chapter, 'id' | 'createdAt'>[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO chapters (job_id, episode_guid, title, start_time, end_time, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((chapters) => {
      for (const chapter of chapters) {
        stmt.run(chapter.jobId, chapter.episodeGuid, chapter.title, chapter.startTime, chapter.endTime, chapter.summary);
      }
    });
    insertMany(chapters);
  }
  
  // Ad removals methods
  async insertAdRemovals(ads: Omit<AdRemoval, 'id' | 'createdAt'>[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO ad_removals (job_id, episode_guid, start_time, end_time, confidence, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((ads) => {
      for (const ad of ads) {
        stmt.run(ad.jobId, ad.episodeGuid, ad.startTime, ad.endTime, ad.confidence, ad.category);
      }
    });
    insertMany(ads);
  }
  
  // Processing results methods
  async saveProcessingResult(result: ProcessingResult): Promise<void> {
    // Get the active job for this episode
    const job = this.db.prepare('SELECT id FROM processing_jobs WHERE episode_guid = ? AND podcast_id = ? ORDER BY created_at DESC LIMIT 1').get(result.episodeId, result.podcastId) as { id: number } | undefined;
    if (!job) {
      throw new Error(`No active job found for episode ${result.episodeId}`);
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO processing_results (job_id, podcast_id, episode_id, original_url, processed_url, ads_removed, chapters, processing_cost, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.id,
      result.podcastId,
      result.episodeId,
      result.originalUrl,
      result.processedUrl,
      JSON.stringify(result.adsRemoved),
      JSON.stringify(result.chapters),
      result.processingCost,
      result.processedAt.toISOString()
    );
  }
  
  async getEpisodeDetails(episodeGuid: string): Promise<any> {
    const upstream = this.db.prepare('SELECT * FROM upstream_episodes WHERE episode_guid = ?').get(episodeGuid);
    const job = this.db.prepare('SELECT * FROM processing_jobs WHERE episode_guid = ? ORDER BY created_at DESC LIMIT 1').get(episodeGuid) as ProcessingJob | undefined;
    const result = job ? this.db.prepare('SELECT * FROM processing_results WHERE job_id = ?').get(job.id) : null;
    const chapters = job ? this.db.prepare('SELECT * FROM chapters WHERE job_id = ?').all(job.id) : [];
    const adRemovals = job ? this.db.prepare('SELECT * FROM ad_removals WHERE job_id = ?').all(job.id) : [];
    const llmCosts = job ? this.db.prepare('SELECT * FROM llm_costs WHERE job_id = ?').all(job.id) : [];
    
    return {
      upstream,
      job,
      result,
      chapters,
      adRemovals,
      llmCosts
    };
  }
}