import Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // Create new processing_results table with updated schema
  db.exec(`
    CREATE TABLE processing_results_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      podcast_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      original_url TEXT NOT NULL,
      processed_url TEXT NOT NULL,
      ads_removed TEXT NOT NULL, -- JSON array of AdDetection
      chapters TEXT NOT NULL, -- JSON array of Chapter
      processing_cost REAL NOT NULL,
      processed_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );
    
    -- Migrate existing data
    INSERT INTO processing_results_new (
      job_id, 
      podcast_id, 
      episode_id, 
      original_url, 
      processed_url, 
      ads_removed, 
      chapters, 
      processing_cost, 
      processed_at
    )
    SELECT 
      r.job_id,
      j.podcast_id,
      r.episode_guid as episode_id,
      u.audio_url as original_url,
      r.processed_audio_url as processed_url,
      '[]' as ads_removed, -- Empty array for now
      '[]' as chapters, -- Empty array for now
      r.total_cost as processing_cost,
      r.created_at as processed_at
    FROM processing_results r
    JOIN processing_jobs j ON r.job_id = j.id
    JOIN upstream_episodes u ON j.episode_guid = u.episode_guid AND j.podcast_id = u.podcast_id;
    
    -- Drop old table and rename new one
    DROP TABLE processing_results;
    ALTER TABLE processing_results_new RENAME TO processing_results;
    
    -- Create indexes
    CREATE INDEX idx_processing_results_episode ON processing_results(episode_id);
    CREATE INDEX idx_processing_results_podcast ON processing_results(podcast_id);
  `);
}

export function down(db: Database.Database): void {
  // Revert to old schema
  db.exec(`
    CREATE TABLE processing_results_old (
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
    
    -- Migrate data back (with some data loss)
    INSERT INTO processing_results_old (
      job_id,
      episode_guid,
      processed_audio_url,
      original_duration,
      processed_duration,
      time_saved,
      total_cost,
      created_at
    )
    SELECT 
      job_id,
      episode_id as episode_guid,
      processed_url as processed_audio_url,
      0 as original_duration, -- Data loss
      0 as processed_duration, -- Data loss
      0 as time_saved, -- Data loss
      processing_cost as total_cost,
      created_at
    FROM processing_results;
    
    DROP TABLE processing_results;
    ALTER TABLE processing_results_old RENAME TO processing_results;
  `);
}