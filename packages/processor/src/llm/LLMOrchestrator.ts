import {
  GoogleGenAI
} from "@google/genai";
import OpenAI from 'openai';
import { AdDetection, Chapter, JobContext } from '@podcastoor/shared';
import { createReadStream, promises as fs } from 'fs';
import { basename } from 'path';

export interface LLMConfig {
  geminiApiKey: string;
  openrouterApiKey: string;
  openrouterEndpoint: string;
  models: {
    geminiAudio: string;
    textAdDetection: string;
    chapters: string;
    enhancement: string;
  };
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  costLimits: {
    maxCostPerEpisode: number;
  };
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
}

export interface AudioAnalysisResult {
  transcript: string;
  adsDetected: AdDetection[]; // From Gemini audio analysis
  audioQualityChanges: Array<{
    timestamp: number;
    description: string;
    possibleAdIndicator: boolean;
  }>;
}

export class LLMOrchestrator {
  private geminiAI: GoogleGenAI;
  private openrouterClient: OpenAI;
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
    
    // OpenRouter client for text-based ad detection
    this.openrouterClient = new OpenAI({
      apiKey: config.openrouterApiKey,
      baseURL: config.openrouterEndpoint,
      timeout: config.timeoutMs
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
          transcript: { type: "string" },
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
          audioQualityChanges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                timestamp: { type: "number" },
                description: { type: "string" },
                possibleAdIndicator: { type: "boolean" }
              },
              required: ["timestamp", "description", "possibleAdIndicator"]
            }
          }
        },
        required: ["transcript", "adsDetected", "audioQualityChanges"]
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

  async refineAdDetection(audioAnalysis: AudioAnalysisResult): Promise<AdDetection[]> {
    console.log(`Stage 2: Refining ad detection with OpenRouter text analysis`);
    
    const startTime = Date.now();
    
    try {
      const textAnalysisPrompt = this.createTextAdDetectionPrompt(audioAnalysis);
      
      const response = await this.openrouterClient.chat.completions.create({
        model: this.config.models.textAdDetection,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at identifying advertisements in podcast transcripts. You will receive a transcript with initial ad detections from audio analysis, and your job is to refine and improve these detections using text-based analysis.'
          },
          {
            role: 'user',
            content: textAnalysisPrompt
          }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        // @ts-ignore - OpenRouter specific parameter
        include: ['usage'],
        stream_options: {
          include_usage: true
        }
      });

      const textAnalysisResult = response.choices[0]?.message?.content;
      if (!textAnalysisResult) {
        throw new Error('No response from OpenRouter');
      }

      const refinedAds = this.parseRefinedAdDetections(textAnalysisResult);
      
      // Merge with original Gemini detections and deduplicate
      const finalAds = this.mergeAndDeduplicateAds(audioAnalysis.adsDetected, refinedAds);
      
      const duration = Date.now() - startTime;
      
      // OpenRouter includes cost in the response when 'usage' is included
      const usage = response.usage as any;
      const cost = usage?.total_cost || undefined;
      
      await this.recordUsage(
        this.config.models.textAdDetection,
        'ad_refinement',
        usage,
        duration
      );
      
      console.log(`Ad detection refinement completed: ${audioAnalysis.adsDetected.length} -> ${finalAds.length} ads`);
      console.log(`Ad redefinition cost: ${cost}`)
      return finalAds;
    } catch (error) {
      console.error('OpenRouter ad refinement failed, using Gemini results:', error);
      // Fallback to just Gemini results if OpenRouter fails
      return audioAnalysis.adsDetected;
    }
  }

  async generateChapters(audioAnalysis: AudioAnalysisResult, finalAds: AdDetection[]): Promise<Chapter[]> {
    console.log('Generating chapters from audio analysis');
    
    const startTime = Date.now();
    
    try {
      const response = await this.openrouterClient.chat.completions.create({
        model: this.config.models.chapters,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at creating meaningful chapter divisions for podcast content. Use the transcript, speaker information, and ad locations to create natural chapter breaks.'
          },
          {
            role: 'user',
            content: this.createChapterGenerationPrompt(audioAnalysis, finalAds)
          }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        // @ts-ignore - OpenRouter specific parameter
        include: ['usage'],
        stream_options: {
          include_usage: true
        }
      });

      const chaptersText = response.choices[0]?.message?.content;
      if (!chaptersText) {
        throw new Error('No response from OpenRouter for chapters');
      }

      const chapters = this.parseChapters(chaptersText);
      
      const duration = Date.now() - startTime;
      
      // OpenRouter includes cost in the response when 'usage' is included
      const usage = response.usage as any;
      const cost = usage?.total_cost || undefined;
      
      await this.recordUsage(
        this.config.models.chapters,
        'chapter_generation',
        usage,
        duration
      );
      
      console.log(`Generated ${chapters.length} chapters`);
      console.log(`Chapter generation cost: ${cost}`)

      return chapters;
    } catch (error) {
      throw new Error(`Chapter generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async enhanceDescription(original: string, chapters: Chapter[], adsRemoved: AdDetection[]): Promise<string> {
    console.log('Enhancing podcast description');
    
    const startTime = Date.now();
    
    try {
      const response = await this.openrouterClient.chat.completions.create({
        model: this.config.models.enhancement,
        messages: [
          {
            role: 'system',
            content: 'You are an expert content editor specializing in podcast descriptions. Create engaging, informative descriptions while maintaining the original tone.'
          },
          {
            role: 'user',
            content: this.createDescriptionPrompt(original, chapters, adsRemoved)
          }
        ],
        temperature: this.config.temperature + 0.3,
        max_tokens: Math.min(this.config.maxTokens, 1000),
        // @ts-ignore - OpenRouter specific parameter
        include: ['usage'],
        stream_options: {
          include_usage: true
        }
      });

      const enhanced = response.choices[0]?.message?.content;
      if (!enhanced) {
        throw new Error('No response from OpenRouter for description');
      }

      const duration = Date.now() - startTime;
      
      // OpenRouter includes cost in the response when 'usage' is included
      const usage = response.usage as any;
      const cost = usage?.total_cost || undefined;
      
      await this.recordUsage(
        this.config.models.enhancement,
        'description_enhancement',
        usage,
        duration
      );

      console.log(`Description redefinition cost: ${cost}`)
      
      return enhanced;
    } catch (error) {
      console.error('Description enhancement failed:', error);
      throw error;
    }
  }


  private createGeminiAudioAnalysisPrompt(): string {
    return `Analyze this podcast audio file and provide:

1. TRANSCRIPTION: Complete transcript with timestamps in [MM:SS] format. Include speaker labels (e.g., "Speaker 1:", "Host:", "Guest:") before each person's speech.

2. AUDIO-BASED AD DETECTION: Identify advertisements by detecting:
   - Sudden audio quality changes (mic setup, recording environment)
   - Different acoustic signatures (studio vs home recording)
   - Background music or sound effects changes
   - Echo, reverb, or compression differences
   - Volume level changes
   - Different room acoustics

3. AUDIO QUALITY CHANGES: Note any technical changes that might indicate ad insertions.

For each detected ad, provide:
- startTime: seconds from start
- endTime: seconds from start
- confidence: 0.0 to 1.0
- adType: "pre-roll", "mid-roll", "post-roll", or "embedded"
- description: what was detected
- detectionReason: "AUDIO_QUALITY_CHANGE", "VOLUME_CHANGE", "ACOUSTIC_CHANGE", or "OTHER"

Ignore any ads that are BOTH natural and under 5 seconds of duration. 

Focus primarily on AUDIO characteristics rather than text content for ad detection.`;
  }

  private createTextAdDetectionPrompt(audioAnalysis: AudioAnalysisResult): string {
    const geminiAds = audioAnalysis.adsDetected.map(ad => 
      `${ad.startTime}s-${ad.endTime}s: ${ad.description} (confidence: ${ad.confidence})`
    ).join('\n');

    return `You are performing Stage 2 ad detection using TEXT analysis to complement Stage 1 audio analysis.

TRANSCRIPT:
###
${audioAnalysis.transcript}
### 

STAGE 1 RESULTS (Audio-based detection):
${geminiAds || 'No ads detected in Stage 1'}

Your job is to:
1. **VALIDATE** Stage 1 detections using text content
2. **FIND MISSED ADS** that weren't caught by audio analysis
3. **IMPROVE TIMESTAMPS** if text provides better boundaries

Look for textual ad indicators:
- "This episode is brought to you by..."
- Product/service mentions with promotional language
- Discount codes, special offers, URLs
- "Thanks to our sponsor..."
- Abrupt topic changes to commercial content
- Call-to-action language

Format as JSON:
{
  "refinedAds": [
    {
      "startTime": 300,
      "endTime": 330,
      "confidence": 0.90,
      "adType": "mid-roll",
      "description": "Promotional content for [product]",
      "detectionReason": "TEXT_BASED",
      "action": "NEW|CONFIRM|REFINE|REJECT",
      "originalGeminiAd": "Reference to Stage 1 detection if applicable"
    }
  ],
  "reasoning": "Explanation of changes made to Stage 1 results"
}

Be conservative - only add new detections if you're confident they're ads.`;
  }

  private createChapterGenerationPrompt(audioAnalysis: AudioAnalysisResult, finalAds: AdDetection[]): string {
    const adTimeRanges = finalAds.map(ad => `${ad.startTime}s-${ad.endTime}s`).join(', ');
    
    return `Create chapters for this podcast using the transcript and avoiding ad segments.

TRANSCRIPT:
${audioAnalysis.transcript}

ADS TO AVOID: ${adTimeRanges || 'None'}

Create meaningful chapters based on:
- Natural conversation breaks and topic changes
- Natural topic transitions, but at a high level
- Avoid creating chapter breaks during ad segments
- Ensure chapters are at least 2 minutes long

Format as JSON:
{
  "chapters": [
    {
      "title": "Chapter Title (1-3 words)",
      "startTime": 0,
      "endTime": 480,
      "description": "Brief description"
    }
  ]
}`;
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
      
      // Validate that we have a transcript
      if (!parsed.transcript || parsed.transcript.length < 50) {
        throw new Error('Invalid or missing transcript in Gemini response');
      }

      // Parse ad detections from Gemini
      const adsDetected: AdDetection[] = (parsed.adsDetected || []).map((ad: any) => ({
        startTime: ad.startTime || 0,
        endTime: ad.endTime || 0,
        confidence: ad.confidence || 0.8,
        adType: ad.adType || 'embedded',
        description: `[AUDIO] ${ad.description}`
      }));

      return {
        transcript: parsed.transcript,
        adsDetected,
        audioQualityChanges: parsed.audioQualityChanges || []
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

  private parseRefinedAdDetections(response: string): AdDetection[] {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      
      return (parsed.refinedAds || [])
        .filter((ad: any) => ad.action !== 'REJECT')
        .map((ad: any) => ({
          startTime: ad.startTime || 0,
          endTime: ad.endTime || 0,
          confidence: ad.confidence || 0.8,
          adType: ad.adType || 'embedded',
          description: `[TEXT] ${ad.description}`
        }));
    } catch (error) {
      console.error('Failed to parse refined ad detections:', error);
      return [];
    }
  }

  private mergeAndDeduplicateAds(geminiAds: AdDetection[], textAds: AdDetection[]): AdDetection[] {
    const merged: AdDetection[] = [...geminiAds];
    
    // Add text-based ads that don't overlap significantly with audio-based ones
    for (const textAd of textAds) {
      const hasOverlap = geminiAds.some(audioAd => {
        const overlap = Math.min(audioAd.endTime, textAd.endTime) - Math.max(audioAd.startTime, textAd.startTime);
        return overlap > 5; // 5 second overlap threshold
      });
      
      if (!hasOverlap) {
        merged.push(textAd);
      }
    }
    
    // Sort by start time and merge overlapping detections
    return this.mergeOverlappingDetections(merged);
  }

  private mergeOverlappingDetections(detections: AdDetection[]): AdDetection[] {
    if (detections.length === 0) return [];

    const sorted = [...detections].sort((a, b) => a.startTime - b.startTime);
    const merged: AdDetection[] = [];
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      
      if (next.startTime <= current.endTime + 5) {
        // Merge overlapping ads
        current = {
          ...current,
          endTime: Math.max(current.endTime, next.endTime),
          confidence: Math.max(current.confidence, next.confidence),
          description: `${current.description} + ${next.description}`
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    
    merged.push(current);
    return merged;
  }

  private parseChapters(response: string): Chapter[] {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      
      return (parsed.chapters || []).map((chapter: any) => ({
        title: chapter.title || 'Untitled Chapter',
        startTime: chapter.startTime || 0,
        endTime: chapter.endTime || 0,
        description: chapter.description
      }));
    } catch (error) {
      console.error('Failed to parse chapters:', error);
      return [];
    }
  }

  private createDescriptionPrompt(original: string, chapters: Chapter[], adsRemoved: AdDetection[]): string {
    const chapterList = chapters.length > 0 
      ? `\n\nChapters:\n${chapters.map(ch => `• ${ch.title}`).join('\n')}`
      : '';
    
    const adNote = adsRemoved.length > 0
      ? `\n\n✂️ This episode has been processed to remove ${adsRemoved.length} advertisement(s) using advanced audio and text analysis.`
      : '';

    return `Enhance this podcast description:

Original: ${original}${chapterList}${adNote}

Make it engaging while noting the ad removal and chapters naturally.`;
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