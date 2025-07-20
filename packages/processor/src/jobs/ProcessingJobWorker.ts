import { DatabaseService } from '../services/database';
import { StorageManager } from '../storage/StorageManager';
import { AudioProcessor } from '../audio/AudioProcessor';
import { LLMOrchestrator } from '../llm/LLMOrchestrator';
import { JobContext, ProcessingJob } from '@podcastoor/shared';
import { formatError } from '@podcastoor/shared';
import type { ProcessingResult } from '@podcastoor/shared';

export class ProcessingJobWorker {
  constructor(
    private db: DatabaseService,
    private storage: StorageManager,
    private audio: AudioProcessor,
    private llm: LLMOrchestrator
  ) {}
  
  async processJob(job: ProcessingJob): Promise<void> {
    const context: JobContext = {
      jobId: job.id,
      startTime: new Date(),
      updateProgress: async (progress, step) => {
        await this.db.updateJobProgress(job.id, progress, step);
      },
      recordLLMCost: async (cost) => {
        await this.db.recordLLMCost({ ...cost, jobId: job.id });
      },
      recordStep: async (name) => {
        await this.db.recordProcessingStep(job.id, name);
      }
    };
    
    try {
      // Get episode details
      const episode = await this.db.getUpstreamEpisode(job.episodeGuid, job.podcastId);
      if (!episode) throw new Error('Episode not found');
      
      // Step 1: Download audio
      await context.recordStep('download_audio');
      await context.updateProgress(10, 'Downloading audio');
      const audioPath = await this.audio.downloadAudio(episode.audioUrl, episode.episodeGuid);
      
      // Step 2: Analyze audio with LLM
      await context.recordStep('analyze_audio');
      await context.updateProgress(30, 'Analyzing audio');
      const startLLM = Date.now();
      
      // Set the job context on the LLM orchestrator
      this.llm.setJobContext(context);
      const analysis = await this.llm.analyzeAudio(audioPath);
      const llmDuration = Date.now() - startLLM;
      
      // Step 3: Refine ad detection
      await context.recordStep('refine_ads');
      await context.updateProgress(50, 'Refining ad detection');
      const refinedAds = await this.llm.refineAdDetection(analysis);
      
      // Step 4: Generate chapters
      await context.recordStep('generate_chapters');
      await context.updateProgress(60, 'Generating chapters');
      const chapters = await this.llm.generateChapters(analysis);
      
      // Step 5: Process audio (remove ads)
      await context.recordStep('process_audio');
      await context.updateProgress(70, 'Processing audio');
      const processedPath = await this.audio.removeAds(audioPath, refinedAds);
      const processedDuration = episode.duration * 0.9; // Estimate for now
      
      // Step 6: Upload processed audio
      await context.recordStep('upload_audio');
      await context.updateProgress(85, 'Uploading processed audio');
      const processedUrl = await this.storage.uploadAudioFile(
        job.podcastId,
        job.episodeGuid,
        processedPath
      );
      
      // Step 7: Upload artifacts
      await context.recordStep('upload_artifacts');
      await context.updateProgress(95, 'Uploading artifacts');
      const artifactsUrl = await this.storage.uploadProcessingArtifacts(
        job.podcastId,
        job.episodeGuid,
        {
          podcastId: job.podcastId,
          episodeId: job.episodeGuid,
          processedAt: new Date().toISOString(),
          audioMetadata: {
            original: { duration: episode.duration, format: 'mp3', bitrate: 128, sampleRate: 44100, channels: 2, size: episode.fileSize },
            processed: { duration: processedDuration, format: 'mp3', bitrate: 128, sampleRate: 44100, channels: 2, size: episode.fileSize * 0.9 }
          },
          speakerCount: 1,
          initialAdsDetected: analysis.adsDetected,
          finalAdsDetected: refinedAds,
          chapters: chapters.map(ch => ({ title: ch.title, startTime: ch.startTime, endTime: ch.endTime, description: ch.description })),
          processingTime: {
            download: 1000,
            analysis: llmDuration,
            adRefinement: 500,
            chapterGeneration: 500,
            audioProcessing: 2000,
            upload: 1000
          },
          timeSaved: episode.duration - processedDuration
        }
      );
      
      // Step 8: Save results
      await context.recordStep('save_results');
      await context.updateProgress(100, 'Saving results');
      
      // Save chapters
      await this.db.insertChapters(
        chapters.map(ch => ({
          jobId: job.id,
          episodeGuid: job.episodeGuid,
          title: ch.title,
          startTime: ch.startTime,
          endTime: ch.endTime,
          summary: ch.description
        }))
      );
      
      // Save ad removals
      await this.db.insertAdRemovals(
        refinedAds.map(ad => ({
          jobId: job.id,
          episodeGuid: job.episodeGuid,
          startTime: ad.startTime,
          endTime: ad.endTime,
          confidence: ad.confidence,
          category: ad.adType
        }))
      );
      
      // Calculate metrics
      const timeSaved = episode.duration - processedDuration;
      const totalCost = await this.db.getJobCosts(job.id)
        .then(costs => costs.reduce((sum, c) => sum + c.cost, 0));
      
      // Save processing result  
      await this.db.saveProcessingResult({
        podcastId: job.podcastId,
        episodeId: job.episodeGuid,
        originalUrl: episode.audioUrl,
        processedUrl: processedUrl,
        adsRemoved: refinedAds,
        chapters: chapters,
        processingCost: totalCost,
        processedAt: new Date()
      });
      
      await this.db.completeJob(job.id);
      
      // Cleanup
      await this.audio.cleanup(audioPath);
      await this.audio.cleanup(processedPath);
      
    } catch (error) {
      await this.db.failJob(job.id, formatError(error));
      throw error;
    }
  }
}