import { AdDetection, Chapter, ProcessingArtifacts, ProcessingResult } from '@podcastoor/shared';
import { PodcastJobData } from '../JobManager';
import { AudioProcessor } from '../../audio/AudioProcessor';
import { LLMOrchestrator } from '../../llm/LLMOrchestrator';
import { StorageManager } from '../../storage/StorageManager';
import { RSSProcessor } from '../../rss/RSSProcessor';
import { join } from 'path';
import { randomUUID } from 'crypto';

interface Job {
  id: number;
  data: PodcastJobData;
  updateProgress(percentage: number): Promise<void>;
  attemptsMade: number;
}

export class PodcastWorker {
  constructor(
    private audioProcessor: AudioProcessor,
    private llmOrchestrator: LLMOrchestrator,
    private storageManager: StorageManager,
    private rssProcessor: RSSProcessor
  ) {}

  async processPodcastEpisode(job: Job): Promise<ProcessingResult> {
    const { podcastId, episodeGuid, audioUrl } = job.data;
    const startTime = Date.now();
    
    console.log(`🔧 PodcastWorker processing: ${podcastId}/${episodeGuid}`);
    
    try {
      // Stage 1: Download audio
      await job.updateProgress(10);
      console.log(`⬇️  Stage 1/8: Downloading audio from ${audioUrl}`);
      const downloadStartTime = Date.now();
      
      const audioPath = await this.audioProcessor.downloadAudio(audioUrl, episodeGuid);
      const audioMetadata = await this.audioProcessor.extractMetadata(audioPath);
      
      const downloadTime = Date.now() - downloadStartTime;
      console.log(`✅ Audio downloaded (${(downloadTime / 1000).toFixed(1)}s): ${audioMetadata.duration}s duration, ${(audioMetadata.size / 1024 / 1024).toFixed(1)}MB`);
      
      // Stage 2: Analyze audio (transcription + initial ad detection)
      await job.updateProgress(30);
      console.log(`🎤 Stage 2/8: Analyzing audio (transcription + initial ad detection)...`);
      const analysisStartTime = Date.now();
      
      const audioAnalysis = await this.llmOrchestrator.analyzeAudio(audioPath);
      
      const analysisTime = Date.now() - analysisStartTime;
      console.log(`✅ Audio analysis completed (${(analysisTime / 1000).toFixed(1)}s): ${audioAnalysis.transcript.length} characters transcribed`);
      console.log(`🎯 Initial ad detection: ${audioAnalysis.adsDetected.length} potential ad segments`);
      
      // Stage 3: Refine ad detection
      await job.updateProgress(50);
      console.log(`🎯 Stage 3/8: Refining ad detection...`);
      const adRefinementStartTime = Date.now();
      
      const finalAds = await this.llmOrchestrator.refineAdDetection(audioAnalysis);
      
      const adRefinementTime = Date.now() - adRefinementStartTime;
      console.log(`✅ Ad detection refinement completed (${(adRefinementTime / 1000).toFixed(1)}s): Found ${finalAds.length} final ad segments`);
      
      // Log detailed ad detection results
      if (finalAds.length > 0) {
        console.log(`📍 Final detected ad segments:`);
        finalAds.forEach((ad: AdDetection, index: number) => {
          console.log(`   • Ad ${index + 1}: ${this.formatTime(ad.startTime)} - ${this.formatTime(ad.endTime)} (${ad.adType}, confidence: ${(ad.confidence * 100).toFixed(1)}%)`);
        });
      } else {
        console.log(`🎉 No ads detected in this episode`);
      }
      
      // Stage 4: Generate chapters
      await job.updateProgress(60);
      console.log(`📚 Stage 4/8: Generating chapters...`);
      const chaptersStartTime = Date.now();
      
      const chapters = await this.llmOrchestrator.generateChapters(audioAnalysis, finalAds);
      
      const chaptersTime = Date.now() - chaptersStartTime;
      console.log(`✅ Chapters generated (${(chaptersTime / 1000).toFixed(1)}s): ${chapters.length} chapters`);
      
      // Stage 5: Process audio (remove ads)
      await job.updateProgress(70);
      console.log(`✂️  Stage 5/8: Processing audio (removing ${finalAds.length} ad segments)...`);
      const audioProcessingStartTime = Date.now();
      
      const processedPath = await this.audioProcessor.removeAds(audioPath, finalAds);
      
      // Get metadata of processed file
      const processedMetadata = await this.audioProcessor.extractMetadata(processedPath);
      
      const audioProcessingTime = Date.now() - audioProcessingStartTime;
      const timeSaved = finalAds.reduce((total: number, ad: AdDetection) => total + (ad.endTime - ad.startTime), 0);
      console.log(`✅ Audio processing completed (${(audioProcessingTime / 1000).toFixed(1)}s): Removed ${timeSaved}s of ads`);
      console.log(`📊 Final audio: ${processedMetadata.duration}s duration, ${(processedMetadata.size / 1024 / 1024).toFixed(1)}MB`);
      
      // Stage 6: Upload processed audio
      await job.updateProgress(85);
      console.log(`☁️  Stage 6/8: Uploading processed audio...`);
      const uploadStartTime = Date.now();
      
      const uploadResult = await this.storageManager.uploadAudio(processedPath, podcastId, episodeGuid);
      
      const uploadTime = Date.now() - uploadStartTime;
      console.log(`✅ Upload completed (${(uploadTime / 1000).toFixed(1)}s): ${uploadResult.url}`);
      
      // Stage 7: Upload processing artifacts
      await job.updateProgress(95);
      console.log(`💾 Stage 7/8: Uploading processing artifacts...`);
      const artifactUploadStartTime = Date.now();
      
      // Prepare artifacts data
      const artifacts: ProcessingArtifacts = {
        podcastId,
        episodeId: episodeGuid,
        processedAt: new Date().toISOString(),
        audioMetadata: {
          original: audioMetadata,
          processed: processedMetadata
        },
        transcript: audioAnalysis.transcript,
        speakerCount: 0,
        initialAdsDetected: audioAnalysis.adsDetected,
        finalAdsDetected: finalAds,
        chapters: chapters,
        processingTime: {
          download: downloadTime,
          analysis: analysisTime,
          adRefinement: adRefinementTime,
          chapterGeneration: chaptersTime,
          audioProcessing: audioProcessingTime,
          upload: uploadTime
        },
        timeSaved: timeSaved
      };
      
      const artifactUploadResult = await this.storageManager.uploadProcessingArtifacts(podcastId, episodeGuid, artifacts);
      
      const artifactUploadTime = Date.now() - artifactUploadStartTime;
      console.log(`✅ Artifacts uploaded (${(artifactUploadTime / 1000).toFixed(1)}s): ${artifactUploadResult.url}`);
      
      // Stage 8: Complete
      await job.updateProgress(100);
      console.log(`🎉 Stage 8/8: Processing complete!`);
      
      // Get actual cost from LLM usage tracking
      const llmUsage = this.llmOrchestrator.getTotalUsage();
      const totalCost = llmUsage.cost;
      const totalTime = Date.now() - startTime;
      
      const result: ProcessingResult = {
        podcastId,
        episodeId: episodeGuid,
        originalUrl: audioUrl,
        processedUrl: uploadResult.url,
        adsRemoved: finalAds,
        chapters: chapters,
        processingCost: totalCost,
        processedAt: new Date()
      };
      
      console.log(`🏁 Episode processing completed: ${podcastId}/${episodeGuid} (${(totalTime / 1000).toFixed(1)}s total)`);
      console.log(`💰 Total processing cost: $${totalCost.toFixed(4)}`);
      
      return result;
    } catch (error) {
      await this.handleProcessingError(error as Error, job);
      throw error;
    }
  }

  private async handleProcessingError(error: Error, job: Job): Promise<void> {
    console.error(`❌ Processing error for job ${job.id}:`, error.message);
    
    // Log error details
    const errorDetails = {
      jobId: job.id,
      podcastId: job.data.podcastId,
      episodeId: job.data.episodeGuid,
      error: error.message,
      stack: error.stack,
      attempt: job.attemptsMade,
      timestamp: new Date().toISOString()
    };
    
    console.error('🔍 Error details:', errorDetails);
    
    // Could implement error notification here
    // await this.notifyError(errorDetails);
  }

  private formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}