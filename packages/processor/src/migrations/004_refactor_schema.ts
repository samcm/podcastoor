import Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // Create upstream_episodes table
  db.exec(`
    CREATE TABLE upstream_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      podcast_id TEXT NOT NULL,
      episode_guid TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      audio_url TEXT NOT NULL,
      publish_date DATETIME NOT NULL,
      duration INTEGER,
      file_size INTEGER,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(podcast_id, episode_guid)
    );
    CREATE INDEX idx_upstream_episodes_podcast ON upstream_episodes(podcast_id);
    CREATE INDEX idx_upstream_episodes_date ON upstream_episodes(publish_date);
  `);
  
  // Create processing_jobs table
  db.exec(`
    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_guid TEXT NOT NULL,
      podcast_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('background', 'manual')),
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      is_protected BOOLEAN DEFAULT FALSE,
      progress INTEGER DEFAULT 0,
      processing_steps TEXT, -- JSON
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      FOREIGN KEY (episode_guid, podcast_id) REFERENCES upstream_episodes(episode_guid, podcast_id)
    );
    CREATE INDEX idx_processing_jobs_status ON processing_jobs(status);
    CREATE INDEX idx_processing_jobs_episode ON processing_jobs(episode_guid);
  `);
  
  // Create llm_costs table
  db.exec(`
    CREATE TABLE llm_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cost REAL NOT NULL,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );
    CREATE INDEX idx_llm_costs_job ON llm_costs(job_id);
  `);
  
  // Create chapters table
  db.exec(`
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      episode_guid TEXT NOT NULL,
      title TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );
    CREATE INDEX idx_chapters_episode ON chapters(episode_guid);
  `);
  
  // Create ad_removals table
  db.exec(`
    CREATE TABLE ad_removals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      episode_guid TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      confidence REAL NOT NULL,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );
    CREATE INDEX idx_ad_removals_episode ON ad_removals(episode_guid);
  `);
  
  // Create processing_results table
  db.exec(`
    CREATE TABLE processing_results (
      job_id INTEGER PRIMARY KEY,
      episode_guid TEXT NOT NULL,
      processed_audio_url TEXT NOT NULL,
      original_duration REAL NOT NULL,
      processed_duration REAL NOT NULL,
      time_saved REAL NOT NULL,
      total_cost REAL NOT NULL,
      artifacts_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );
  `);
  
  // Migrate existing data
  db.exec(`
    -- Copy episodes to upstream_episodes
    INSERT INTO upstream_episodes (podcast_id, episode_guid, title, description, audio_url, publish_date, duration, file_size)
    SELECT podcast_id, episode_guid, title, description, audio_url, publish_date, duration, 0
    FROM episodes;
    
    -- Create processing jobs for completed episodes
    INSERT INTO processing_jobs (episode_guid, podcast_id, reason, status, completed_at)
    SELECT episode_guid, podcast_id, 'background', 'completed', processed_at
    FROM episodes
    WHERE status = 'completed';
    
    -- Migrate processing results
    INSERT INTO processing_results (job_id, episode_guid, processed_audio_url, original_duration, processed_duration, time_saved, total_cost)
    SELECT j.id, e.episode_guid, e.processed_url, e.duration, e.duration * 0.9, e.duration * 0.1, COALESCE(e.processing_cost, 0)
    FROM episodes e
    JOIN processing_jobs j ON e.episode_guid = j.episode_guid
    WHERE e.status = 'completed';
  `);
}

export function down(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS processing_results;
    DROP TABLE IF EXISTS ad_removals;
    DROP TABLE IF EXISTS chapters;
    DROP TABLE IF EXISTS llm_costs;
    DROP TABLE IF EXISTS processing_jobs;
    DROP TABLE IF EXISTS upstream_episodes;
  `);
}