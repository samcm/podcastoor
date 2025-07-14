import { DatabaseService } from '../services/database';

interface ProcessingConfig {
  jobPollInterval: number;
  maxEpisodesPerPodcast: number;
  episodeRetentionDays: number;
}

export class BackgroundScanner {
  private scanInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private db: DatabaseService,
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
      const podcasts = await this.db.getAllPodcasts();
      
      for (const podcast of podcasts) {
        const unprocessed = await this.db.getUnprocessedEpisodes(
          podcast.id,
          this.config.maxEpisodesPerPodcast
        );
        
        for (const episode of unprocessed) {
          // Check if episode is within retention period
          const ageInDays = (Date.now() - episode.publishDate.getTime()) / (1000 * 60 * 60 * 24);
          if (ageInDays > this.config.episodeRetentionDays) {
            console.log(`Skipping old episode ${episode.episodeGuid} (${ageInDays.toFixed(1)} days old)`);
            continue;
          }
          
          // Create background processing job
          await this.db.createProcessingJob({
            episodeGuid: episode.episodeGuid,
            podcastId: episode.podcastId,
            reason: 'background',
            priority: 0,
            isProtected: false
          });
          
          console.log(`Created background job for episode ${episode.episodeGuid}`);
        }
      }
    } catch (error) {
      console.error('Background scan failed:', error);
    }
  }
}