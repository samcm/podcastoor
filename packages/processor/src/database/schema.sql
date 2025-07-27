-- Podcastoor Database Schema

-- Shows (podcasts)
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY, -- Use RSS podcast ID
  title TEXT NOT NULL,
  description TEXT,
  feed_url TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Episodes from RSS feeds
CREATE TABLE IF NOT EXISTS episodes (
  guid TEXT PRIMARY KEY, -- Episode GUID is unique
  show_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  audio_url TEXT NOT NULL,
  publish_date DATETIME NOT NULL,
  duration INTEGER, -- seconds
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (show_id) REFERENCES shows(id)
);

-- Processing jobs
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_guid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  error TEXT,
  priority INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  FOREIGN KEY (episode_guid) REFERENCES episodes(guid)
);

-- Processed episode results
CREATE TABLE IF NOT EXISTS processed_episodes (
  job_id INTEGER PRIMARY KEY,
  processed_url TEXT NOT NULL,
  original_duration REAL NOT NULL,
  processed_duration REAL NOT NULL,
  processing_cost REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Detected chapters
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  summary TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Detected ads
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  confidence REAL NOT NULL,
  type TEXT CHECK(type IN ('pre-roll', 'mid-roll', 'post-roll', 'unknown')),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_episodes_publish ON episodes(publish_date);
CREATE INDEX IF NOT EXISTS idx_jobs_episode ON jobs(episode_guid);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_chapters_job ON chapters(job_id);
CREATE INDEX IF NOT EXISTS idx_ads_job ON ads(job_id);