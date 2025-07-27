import { AdDetection, AdSegment, Chapter, ProcessingArtifacts, ProcessingResult } from '@podcastoor/shared';
import { AudioProcessor } from '../../audio/AudioProcessor';
import { LLMOrchestrator } from '../../llm/LLMOrchestrator';
import { StorageManager } from '../../storage/StorageManager';
import { RSSProcessor } from '../../rss/RSSProcessor';

export class PodcastWorker {
  constructor(
    private audioProcessor: AudioProcessor,
    private llmOrchestrator: LLMOrchestrator,
    private storageManager: StorageManager,
    private rssProcessor: RSSProcessor
  ) {}

  async process(data: {
    podcastId: string;
    episodeId: string;
    audioUrl: string;
    minAdDuration: number;
    episodeTitle: string;
    duration: number;
    jobId: number;
  }): Promise<ProcessingResult> {
    const { podcastId, episodeId, audioUrl, minAdDuration, jobId } = data;
    const startTime = Date.now();
    
    console.log(`🔧 PodcastWorker processing: ${podcastId}/${episodeId}`);
    
    try {
      // Stage 1: Download audio
      console.log(`[Job ${jobId}] Progress: 10% - Starting download`);
      console.log(`⬇️  Stage 1/8: Downloading audio from ${audioUrl}`);
      const downloadStartTime = Date.now();
      
      const audioPath = await this.audioProcessor.downloadAudio(audioUrl, episodeId);
      const audioMetadata = await this.audioProcessor.extractMetadata(audioPath);
      
      const downloadTime = Date.now() - downloadStartTime;
      console.log(`✅ Audio downloaded (${(downloadTime / 1000).toFixed(1)}s): ${audioMetadata.duration}s duration, ${(audioMetadata.size / 1024 / 1024).toFixed(1)}MB`);
      
      // Stage 2: Analyze audio (transcription + initial ad detection)
      console.log(`[Job ${jobId}] Progress: 30% - Analyzing audio`);
      console.log(`🎤 Stage 2/8: Analyzing audio (transcription + initial ad detection)...`);
      const analysisStartTime = Date.now();
      
      const audioAnalysis = await this.llmOrchestrator.analyzeAudio(audioPath);
      
      const analysisTime = Date.now() - analysisStartTime;
      console.log(`✅ Audio analysis completed (${(analysisTime / 1000).toFixed(1)}s)`);
      console.log(`🎯 Initial ad detection: ${audioAnalysis.adsDetected.length} potential ad segments`);
      
      // Stage 3: Refine ad detection
      console.log(`[Job ${jobId}] Progress: 50% - Refining ad detection`);
      console.log(`🎯 Stage 3/8: Refining ad detection...`);
      const adRefinementStartTime = Date.now();
      
      const finalAds = await this.llmOrchestrator.refineAdDetection(audioAnalysis, minAdDuration);
      
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
      console.log(`[Job ${jobId}] Progress: 60% - Generating chapters`);
      console.log(`📚 Stage 4/8: Generating chapters...`);
      const chaptersStartTime = Date.now();
      
      const chapters = await this.llmOrchestrator.generateChapters(audioAnalysis);
      
      const chaptersTime = Date.now() - chaptersStartTime;
      console.log(`✅ Chapters generated (${(chaptersTime / 1000).toFixed(1)}s): ${chapters.length} chapters`);
      
      // Stage 5: Process audio (remove ads and extract ad segments)
      console.log(`[Job ${jobId}] Progress: 70% - Processing audio`);
      console.log(`✂️  Stage 5/8: Processing audio (removing ${finalAds.length} ad segments)...`);
      const audioProcessingStartTime = Date.now();
      
      // Remove ads from the main audio
      const processedPath = await this.audioProcessor.removeAds(audioPath, finalAds);
      
      // Extract individual ad segments
      let adSegments: AdSegment[] = [];
      if (finalAds.length > 0) {
        console.log(`🎯 Extracting ${finalAds.length} ad segments...`);
        const adPaths = await this.audioProcessor.extractAdSegments(audioPath, finalAds, episodeId);
        
        // Upload each ad segment
        for (let i = 0; i < adPaths.length; i++) {
          const adPath = adPaths[i];
          const ad = finalAds[i];
          
          try {
            const adUploadResult = await this.storageManager.uploadAdSegment(
              adPath,
              podcastId,
              episodeId,
              i + 1,
              ad.adType
            );
            
            const adMetadata = await this.audioProcessor.extractMetadata(adPath);
            
            adSegments.push({
              ...ad,
              title: ad.description || `${ad.adType} Ad ${i + 1}`,
              audioUrl: adUploadResult.url,
              duration: adMetadata.duration
            });
            
            console.log(`✅ Ad segment ${i + 1} uploaded: ${adUploadResult.url}`);
            
            // Clean up the temporary ad file
            await this.audioProcessor.cleanup(adPath);
          } catch (error) {
            console.error(`Failed to upload ad segment ${i + 1}:`, error);
          }
        }
      }
      
      // Get metadata of processed file
      const processedMetadata = await this.audioProcessor.extractMetadata(processedPath);
      
      const audioProcessingTime = Date.now() - audioProcessingStartTime;
      const timeSaved = finalAds.reduce((total: number, ad: AdDetection) => total + (ad.endTime - ad.startTime), 0);
      console.log(`✅ Audio processing completed (${(audioProcessingTime / 1000).toFixed(1)}s): Removed ${timeSaved}s of ads`);
      console.log(`📊 Final audio: ${processedMetadata.duration}s duration, ${(processedMetadata.size / 1024 / 1024).toFixed(1)}MB`);
      
      // Stage 6: Upload processed audio
      console.log(`[Job ${jobId}] Progress: 85% - Uploading processed audio`);
      console.log(`☁️  Stage 6/8: Uploading processed audio...`);
      const uploadStartTime = Date.now();
      
      const uploadResult = await this.storageManager.uploadAudio(processedPath, podcastId, episodeId);
      
      const uploadTime = Date.now() - uploadStartTime;
      console.log(`✅ Upload completed (${(uploadTime / 1000).toFixed(1)}s): ${uploadResult.url}`);
      
      // Stage 7: Upload processing artifacts
      console.log(`[Job ${jobId}] Progress: 95% - Uploading artifacts`);
      console.log(`💾 Stage 7/8: Uploading processing artifacts...`);
      const artifactUploadStartTime = Date.now();
      
      // Prepare artifacts data
      const artifacts: ProcessingArtifacts = {
        podcastId,
        episodeId: episodeId,
        processedAt: new Date().toISOString(),
        audioMetadata: {
          original: audioMetadata,
          processed: processedMetadata
        },
        speakerCount: 0,
        initialAdsDetected: audioAnalysis.adsDetected,
        finalAdsDetected: finalAds,
        adSegments: adSegments,
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
      
      const artifactUploadResult = await this.storageManager.uploadProcessingArtifacts(podcastId, episodeId, artifacts);
      
      const artifactUploadTime = Date.now() - artifactUploadStartTime;
      console.log(`✅ Artifacts uploaded (${(artifactUploadTime / 1000).toFixed(1)}s): ${artifactUploadResult.url}`);
      
      // Stage 8: Complete
      console.log(`[Job ${jobId}] Progress: 100% - Processing complete`);
      console.log(`🎉 Stage 8/8: Processing complete!`);
      
      // Get actual cost from LLM usage tracking
      const llmUsage = this.llmOrchestrator.getTotalUsage();
      const totalCost = llmUsage.cost;
      const totalTime = Date.now() - startTime;
      
      const result: ProcessingResult = {
        podcastId,
        episodeId: episodeId,
        originalUrl: audioUrl,
        processedUrl: uploadResult.url,
        originalDuration: audioMetadata.duration,
        processedDuration: processedMetadata.duration,
        adsRemoved: finalAds,
        adSegments: adSegments,
        chapters: chapters,
        processingCost: totalCost,
        processedAt: new Date()
      };
      
      console.log(`🏁 Episode processing completed: ${podcastId}/${episodeId} (${(totalTime / 1000).toFixed(1)}s total)`);
      console.log(`💰 Total processing cost: $${totalCost.toFixed(4)}`);
      
      return result;
    } catch (error) {
      await this.handleProcessingError(error as Error, jobId, podcastId, episodeId);
      throw error;
    }
  }

  private async handleProcessingError(error: Error, jobId: number, podcastId: string, episodeId: string): Promise<void> {
    console.error(`❌ Processing error for job ${jobId}:`, error.message);
    
    // Log error details
    const errorDetails = {
      jobId: jobId,
      podcastId: podcastId,
      episodeId: episodeId,
      error: error.message,
      stack: error.stack,
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