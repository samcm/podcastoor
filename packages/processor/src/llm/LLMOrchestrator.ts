import {
  GoogleGenAI
} from "@google/genai";
import { AdDetection, Chapter, JobContext } from '@podcastoor/shared';
import { promises as fs } from 'fs';
import { basename } from 'path';

export interface LLMConfig {
  geminiApiKey: string;
  models: {
    geminiAudio: string;
  };
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
}

export interface AudioAnalysisResult {
  adsDetected: AdDetection[]; // From Gemini audio analysis
  chapters: Chapter[]; // Chapters generated by Gemini
}

export class LLMOrchestrator {
  private geminiAI: GoogleGenAI;
  private config: LLMConfig;
  private jobContext?: JobContext;
  private totalUsage: LLMUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    duration: 0
  };

  constructor(config: LLMConfig) {
    this.config = config;
    this.geminiAI = new GoogleGenAI({
      apiKey: config.geminiApiKey
    });
  }

  setJobContext(context: JobContext): void {
    this.jobContext = context;
  }
  
  private async recordUsage(
    model: string,
    operation: string,
    usage: any,
    durationMs: number
  ): Promise<void> {
    if (this.jobContext) {
      await this.jobContext.recordLLMCost({
        model,
        operation,
        inputTokens: usage?.prompt_tokens || usage?.input_tokens || 0,
        outputTokens: usage?.completion_tokens || usage?.output_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        cost: usage?.total_cost || usage?.cost || 0,
        durationMs
      });
    }
    
    // Still track in totalUsage for backward compatibility
    this.totalUsage.inputTokens += usage?.prompt_tokens || usage?.input_tokens || 0;
    this.totalUsage.outputTokens += usage?.completion_tokens || usage?.output_tokens || 0;
    this.totalUsage.cost += usage?.total_cost || usage?.cost || 0;
    this.totalUsage.duration += durationMs;
  }

  async analyzeAudio(audioPath: string): Promise<AudioAnalysisResult> {
    console.log(`Stage 1: Analyzing audio with Gemini: ${audioPath}`);
    
    const startTime = Date.now();
    
    try {
      const fileName = basename(audioPath);
      const fileStats = await fs.stat(audioPath);
      console.log(`Uploading audio file: ${fileName} (${(fileStats.size / 1024 / 1024).toFixed(1)}MB)`);
      
      // Upload audio file to Gemini
      const uploadedFile = await this.geminiAI.files.upload({
        file: audioPath,
        config: { mimeType: "audio/mp3" },
      });

      console.log(`File uploaded: ${uploadedFile.uri}`);
      
      const analysisPrompt = this.createGeminiAudioAnalysisPrompt();

      console.log("Prompting gemini for initial analysis...")

      // Define JSON schema for structured output using the Google SDK Type system
      const responseSchema = {
        type: "object",
        properties: {
          adsDetected: {
            type: "array",
            items: {
              type: "object",
              properties: {
                startTime: { type: "number" },
                endTime: { type: "number" },
                confidence: { type: "number" },
                adType: { type: "string" },
                description: { type: "string" },
                detectionReason: { type: "string" }
              },
              required: ["startTime", "endTime", "confidence", "adType", "description", "detectionReason"]
            }
          },
          chapters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                startTime: { type: "number" },
                endTime: { type: "number" },
                description: { type: "string" }
              },
              required: ["title", "startTime", "endTime"]
            }
          },
        },
        required: ["adsDetected", "chapters"]
      };

      // Generate content using the uploaded file with structured output
      // Use streaming to handle large responses
      console.log('Starting Gemini audio analysis with streaming...');
      
      const streamingResponse = await this.geminiAI.models.generateContentStream({
        model: this.config.models.geminiAudio,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: uploadedFile.mimeType!, fileUri: uploadedFile.uri! } },
              { text: analysisPrompt }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          maxOutputTokens: 66000,
          temperature: 0.1,
          thinkingConfig: {
            thinkingBudget: 0,
          }
        }
      });
      
      // Collect all chunks
      let analysisText = '';
      let chunkCount = 0;
      let usageMetadata: any = null;
      
      for await (const chunk of streamingResponse) {
        const chunkText = chunk.text;
        if (chunkText) {
          analysisText += chunkText;
          chunkCount++;
          if (chunkCount % 10 === 0) {
            console.log(`Received ${chunkCount} chunks, current length: ${analysisText.length}`);
          }
        }
        // Capture usage metadata from the last chunk
        if (chunk.usageMetadata) {
          usageMetadata = chunk.usageMetadata;
        }
      }
      
      console.log(`Streaming complete. Total chunks: ${chunkCount}, Total length: ${analysisText.length}`);
      
      if (!analysisText) {
        throw new Error('Empty response from Gemini API');
      }
      
      console.log(`Gemini audio analysis completed in ${Date.now() - startTime}ms`);
      
      // Log first 500 chars of response for debugging
      console.log(`Gemini response preview: ${analysisText.substring(0, 500)}...`);
      
      // Parse the structured response
      const parsedResult = this.parseGeminiAudioAnalysis(analysisText);
      
      // Clean up uploaded file
      try {
        if (uploadedFile.name) {
          await this.geminiAI.files.delete({
            name: uploadedFile.name
          });
          console.log(`Cleaned up uploaded file: ${uploadedFile.name}`);
        }
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }
      
      const duration = Date.now() - startTime;
      
      // Use the captured usageMetadata from streaming
      const inputTokens = usageMetadata?.promptTokenCount || 0;
      const outputTokens = usageMetadata?.candidatesTokenCount || usageMetadata?.totalTokenCount || this.estimateTokens(analysisText);
      
      // Gemini 1.5 Flash pricing per 1M tokens (Paid Tier)
      // For prompts <= 128k tokens: $0.075 input, $0.30 output
      // For prompts > 128k tokens: $0.15 input, $0.60 output
      const isLargePrompt = inputTokens > 128_000;
      const inputRate = isLargePrompt ? 0.15 : 0.075;
      const outputRate = isLargePrompt ? 0.60 : 0.30;
      
      const inputCost = (inputTokens / 1_000_000) * inputRate;
      const outputCost = (outputTokens / 1_000_000) * outputRate;

      console.log(`Initial gemini cost: Input: ${inputCost}, Output: ${outputCost}`)
      
      // Record usage with new method
      await this.recordUsage(
        this.config.models.geminiAudio,
        'audio_analysis',
        {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost: inputCost + outputCost
        },
        duration
      );
      
      return parsedResult;
    } catch (error) {
      throw new Error(`Gemini audio analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async refineAdDetection(audioAnalysis: AudioAnalysisResult, minAdDuration: number = 3): Promise<AdDetection[]> {
    console.log(`Stage 2: Ad detection already complete in Gemini analysis`);
    console.log(`Ad detection: ${audioAnalysis.adsDetected.length} ads detected`);
    
    // Filter ads by minimum duration
    const filteredAds = audioAnalysis.adsDetected.filter(ad => {
      const duration = ad.endTime - ad.startTime;
      const meetsMinimum = duration >= minAdDuration;
      
      if (!meetsMinimum) {
        console.log(`⏭️  Ignoring ad segment (${duration.toFixed(1)}s < ${minAdDuration}s minimum): ${ad.startTime.toFixed(2)}s - ${ad.endTime.toFixed(2)}s`);
      }
      
      return meetsMinimum;
    });
    
    console.log(`🎯 Filtered ads by minimum duration (${minAdDuration}s): ${audioAnalysis.adsDetected.length} → ${filteredAds.length} ads`);
    
    return filteredAds;
  }

  async generateChapters(audioAnalysis: AudioAnalysisResult): Promise<Chapter[]> {
    console.log(`Chapters already generated in Gemini analysis`);
    console.log(`Generated ${audioAnalysis.chapters.length} chapters`);
    
    // Since Gemini now generates chapters along with the transcript and ad detection,
    // we can just return the chapters generated by Gemini
    return audioAnalysis.chapters;
  }



  private createGeminiAudioAnalysisPrompt(): string {
    return `Analyze this podcast audio file and provide:

1. AD DETECTION: Identify advertisements using BOTH audio characteristics AND text content:
   Audio indicators:
   - Sudden audio quality changes (mic setup, recording environment)
   - Different acoustic signatures (studio vs home recording)
   - Background music or sound effects changes
   - Echo, reverb, or compression differences
   - Volume level changes
   - Different room acoustics
   
   Text indicators:
   - "This episode is brought to you by..."
   - Product/service mentions with promotional language
   - Discount codes, special offers, URLs
   - "Thanks to our sponsor..."
   - Abrupt topic changes to commercial content
   - Call-to-action language

   Other considerations:
   - Commercial content is not always marked as ads. For example, if a podcast talks about a live show that they are presenting, that is not an ad. 
   - If you aren't sure, don't mark it as an ad.
   - Combine audio indicators with text indicators to make a decision.

   For each detected ad, provide:
    - startTime: seconds from start
    - endTime: seconds from start
    - confidence: 0.0 to 1.0
    - adType: "pre-roll", "mid-roll", "post-roll", or "embedded"
    - description: what was detected. e.g. "An ad for product x"
    - detectionReason: "AUDIO_QUALITY_CHANGE", "VOLUME_CHANGE", "ACOUSTIC_CHANGE", "TEXT_CONTENT", "COMBINED" or anything else you think is relevant

2. CHAPTERS: Create meaningful chapters based on natural topic transitions. Ensure:
   - Chapters are at least 5 minutes long
   - Avoid creating chapter breaks during ad segments
   - Use concise titles (1-3 words)
   - Focus on high-level topic changes, not minor transitions
   - Chapters should span distinct topics, not just minor changes in topic. For example, if a podcast talks about 5 different NRL topics in a window of 10 minutes, there should be 1 chapter titled "NRL" that spans the entire 10 minute period.
   - Chapters must not contain any ads as the ads will be removed from the audio file.

  For each chapter, provide:
  - title: concise chapter title (1-3 words)
  - startTime: seconds from start
  - endTime: seconds from start
  - description: optional brief description

Be comprehensive in ad detection but conservative - only mark content as ads if you're confident.`;
  }



  private parseGeminiAudioAnalysis(analysisText: string): AudioAnalysisResult {
    try {
      // Check if the response is complete JSON
      if (!analysisText.trim()) {
        throw new Error('Empty response from Gemini API');
      }
      
      // Check if response might be truncated
      const trimmedText = analysisText.trim();
      if (!trimmedText.endsWith('}')) {
        console.error('Response appears to be truncated. Last 100 chars:', trimmedText.slice(-100));
        throw new Error('Incomplete JSON response from Gemini API - response may have been truncated');
      }
      
      // With structured output, Gemini returns valid JSON directly
      const parsed = JSON.parse(analysisText);
      
      // Parse ad detections from Gemini
      const adsDetected: AdDetection[] = (parsed.adsDetected || []).map((ad: any) => ({
        startTime: ad.startTime || 0,
        endTime: ad.endTime || 0,
        confidence: ad.confidence || 0.8,
        adType: ad.adType || 'embedded',
        description: `[AUDIO] ${ad.description}`
      }));

      // Parse chapters from Gemini
      const chapters: Chapter[] = (parsed.chapters || []).map((chapter: any) => ({
        title: chapter.title || 'Untitled Chapter',
        startTime: chapter.startTime || 0,
        endTime: chapter.endTime || 0,
        description: chapter.description
      }));

      return {
        adsDetected,
        chapters,
      };
    } catch (error) {
      // Log the full response for debugging
      console.error('Failed to parse Gemini response. Response length:', analysisText.length);
      console.error('First 500 chars:', analysisText.substring(0, 500));
      console.error('Last 500 chars:', analysisText.substring(Math.max(0, analysisText.length - 500)));
      
      // Check if it's a JSON parsing error
      if (error instanceof SyntaxError && error.message.includes('JSON')) {
        // Try to detect HTML error responses
        if (analysisText.includes('<!DOCTYPE') || analysisText.includes('<html')) {
          throw new Error('Received HTML response instead of JSON - possible API error or rate limit');
        }
        throw new Error(`Failed to parse Gemini audio analysis: ${error.message}`);
      }
      
      // Re-throw the error to fail the entire processing job
      throw new Error(`Failed to parse Gemini audio analysis: ${error instanceof Error ? error.message : String(error)}`);
    }
  }






  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }


  getTotalUsage(): LLMUsage {
    return { ...this.totalUsage };
  }

  resetUsage(): void {
    this.totalUsage = { inputTokens: 0, outputTokens: 0, cost: 0, duration: 0 };
  }
}