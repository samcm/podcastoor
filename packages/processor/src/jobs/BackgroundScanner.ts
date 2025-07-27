import { Database } from '../database/Database';

interface ProcessingConfig {
  jobPollInterval: number;
  maxEpisodesPerPodcast: number;
  episodeRetentionDays: number;
}

export class BackgroundScanner {
  private scanInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private db: Database,
    private config: ProcessingConfig
  ) {}
  
  start(): void {
    const intervalMs = this.config.jobPollInterval * 1000;
    this.scanInterval = setInterval(() => this.scan(), intervalMs);
    console.log('Background scanner started');
    
    // Run initial scan
    this.scan();
  }
  
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    console.log('Background scanner stopped');
  }
  
  private async scan(): Promise<void> {
    try {
      const shows = this.db.getAllShows();
      
      for (const show of shows) {
        // Get all episodes for the show
        const episodes = this.db.getShowEpisodes(show.id, this.config.maxEpisodesPerPodcast);
        
        // Filter to get unprocessed episodes
        const unprocessed = [];
        for (const episode of episodes) {
          const jobs = this.db.getEpisodeJobs(episode.guid);
          const hasCompletedJob = jobs.some(job => job.status === 'completed');
          if (!hasCompletedJob) {
            unprocessed.push(episode);
          }
        }
        
        for (const episode of unprocessed) {
          // Check if episode is within retention period
          const ageInDays = (Date.now() - episode.publishDate.getTime()) / (1000 * 60 * 60 * 24);
          if (ageInDays > this.config.episodeRetentionDays) {
            console.log(`Skipping old episode ${episode.guid} (${ageInDays.toFixed(1)} days old`);
            continue;
          }
          
          // Create background processing job
          this.db.createJob(episode.guid, 0);
          
          console.log(`Created background job for episode ${episode.guid}`);
        }
      }
    } catch (error) {
      console.error('Background scan failed:', error);
    }
  }
}