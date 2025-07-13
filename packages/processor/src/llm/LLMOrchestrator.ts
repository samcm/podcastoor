import OpenAI from 'openai';
import { AdDetection, Chapter } from '@podcastoor/shared';
import { createReadStream } from 'fs';

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  models: {
    transcription: string;
    adDetection: string;
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

export class LLMOrchestrator {
  private client: OpenAI;
  private config: LLMConfig;
  private totalUsage: LLMUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    duration: 0
  };

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.endpoint,
      timeout: config.timeoutMs
    });
  }

  async transcribeAudio(audioPath: string): Promise<string> {
    console.log(`Transcribing audio: ${audioPath}`);
    
    const startTime = Date.now();
    
    try {
      const transcription = await this.client.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: this.config.models.transcription,
        response_format: 'text'
      });

      const duration = Date.now() - startTime;
      console.log(`Transcription completed in ${duration}ms`);
      
      return transcription;
    } catch (error) {
      throw new Error(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async detectAds(transcript: string): Promise<AdDetection[]> {
    console.log(`Detecting ads in transcript (${transcript.length} characters)`);
    
    const chunks = this.createChunks(transcript, 8000); // ~8k characters per chunk
    const allDetections: AdDetection[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`Processing ad detection chunk ${i + 1}/${chunks.length}`);
      
      const startTime = Date.now();
      
      try {
        const response = await this.client.chat.completions.create({
          model: this.config.models.adDetection,
          messages: [
            {
              role: 'system',
              content: 'You are an expert at identifying advertisements in podcast transcripts. Return only valid JSON arrays.'
            },
            {
              role: 'user',
              content: this.getAdDetectionPrompt(chunk.content)
            }
          ],
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          console.warn(`No response content for chunk ${i + 1}`);
          continue;
        }

        const detections = this.parseAdDetections(content);
        
        // Adjust detection times based on chunk offset
        const adjustedDetections = detections.map(detection => ({
          ...detection,
          startTime: detection.startTime + chunk.startTime,
          endTime: detection.endTime + chunk.startTime
        }));

        allDetections.push(...adjustedDetections);

        const duration = Date.now() - startTime;
        this.recordUsage(response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, duration);
        
      } catch (error) {
        console.error(`Ad detection failed for chunk ${i + 1}:`, error);
        throw error; // Don't continue, let job system retry
      }
    }

    return this.mergeOverlappingDetections(allDetections);
  }

  async generateChapters(transcript: string): Promise<Chapter[]> {
    console.log(`Generating chapters for transcript (${transcript.length} characters)`);
    
    const chunks = this.createChunks(transcript, 12000); // Larger chunks for chapters
    const allChapters: Chapter[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`Processing chapter generation chunk ${i + 1}/${chunks.length}`);
      
      const startTime = Date.now();
      
      try {
        const response = await this.client.chat.completions.create({
          model: this.config.models.chapters,
          messages: [
            {
              role: 'system',
              content: 'You are an expert at creating meaningful chapter divisions for podcast content. Return only valid JSON arrays.'
            },
            {
              role: 'user',
              content: this.getChapterGenerationPrompt(chunk.content)
            }
          ],
          temperature: this.config.temperature + 0.2, // Slightly more creative
          max_tokens: this.config.maxTokens
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          console.warn(`No response content for chunk ${i + 1}`);
          continue;
        }

        const chapters = this.parseChapters(content);
        
        // Adjust chapter times based on chunk offset
        const adjustedChapters = chapters.map(chapter => ({
          ...chapter,
          startTime: chapter.startTime + chunk.startTime,
          endTime: chapter.endTime + chunk.startTime
        }));

        allChapters.push(...adjustedChapters);

        const duration = Date.now() - startTime;
        this.recordUsage(response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, duration);
        
      } catch (error) {
        console.error(`Chapter generation failed for chunk ${i + 1}:`, error);
        throw error; // Don't continue, let job system retry
      }
    }

    return this.mergeAdjacentChapters(allChapters);
  }

  async enhanceDescription(original: string, chapters: Chapter[], adsRemoved: AdDetection[]): Promise<string> {
    console.log('Enhancing podcast description');
    
    const enhancementPrompt = this.createDescriptionPrompt(original, chapters, adsRemoved);
    const startTime = Date.now();
    
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.models.enhancement,
        messages: [
          {
            role: 'system',
            content: 'You are an expert content editor specializing in podcast descriptions. Create engaging, informative descriptions while maintaining the original tone.'
          },
          {
            role: 'user',
            content: enhancementPrompt
          }
        ],
        temperature: this.config.temperature + 0.3, // More creative for descriptions
        max_tokens: Math.min(this.config.maxTokens, 1000)
      });

      const enhanced = response.choices[0]?.message?.content;
      if (!enhanced) {
        throw new Error('No response content for description enhancement');
      }

      const duration = Date.now() - startTime;
      this.recordUsage(response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, duration);
      
      return enhanced;
    } catch (error) {
      console.error('Description enhancement failed:', error);
      throw error;
    }
  }

  private createChunks(text: string, maxChars: number): Array<{content: string, startTime: number, endTime: number}> {
    const chunks: Array<{content: string, startTime: number, endTime: number}> = [];
    const overlap = Math.floor(maxChars * 0.1); // 10% overlap
    
    // Estimate total duration (150 words per minute average)
    const words = text.split(/\s+/).length;
    const estimatedDuration = (words / 150) * 60; // seconds
    
    let currentPos = 0;
    let chunkIndex = 0;
    
    while (currentPos < text.length) {
      const endPos = Math.min(currentPos + maxChars, text.length);
      
      // Try to break at sentence boundaries
      let actualEndPos = endPos;
      if (endPos < text.length) {
        const lastSentence = text.lastIndexOf('.', endPos);
        const lastQuestion = text.lastIndexOf('?', endPos);
        const lastExclamation = text.lastIndexOf('!', endPos);
        
        const lastPunctuation = Math.max(lastSentence, lastQuestion, lastExclamation);
        if (lastPunctuation > currentPos + (maxChars * 0.5)) {
          actualEndPos = lastPunctuation + 1;
        }
      }
      
      const chunkText = text.slice(currentPos, actualEndPos).trim();
      if (chunkText.length > 0) {
        const startTime = (currentPos / text.length) * estimatedDuration;
        const endTime = (actualEndPos / text.length) * estimatedDuration;
        
        chunks.push({
          content: chunkText,
          startTime,
          endTime
        });
      }
      
      currentPos = actualEndPos - overlap;
      if (currentPos >= actualEndPos) {
        currentPos = actualEndPos; // Prevent infinite loop
      }
      chunkIndex++;
    }
    
    return chunks;
  }

  private parseAdDetections(response: string): AdDetection[] {
    try {
      // Clean the response to extract JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? jsonMatch[0] : response;
      
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.warn('Ad detection response is not an array');
        return [];
      }

      return parsed.map(ad => ({
        startTime: Number(ad.startTime) || 0,
        endTime: Number(ad.endTime) || 0,
        confidence: Number(ad.confidence) || 0.8,
        adType: ad.adType || 'embedded',
        description: ad.description
      }));
    } catch (error) {
      console.error('Failed to parse ad detections:', error);
      return [];
    }
  }

  private parseChapters(response: string): Chapter[] {
    try {
      // Clean the response to extract JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? jsonMatch[0] : response;
      
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.warn('Chapter response is not an array');
        return [];
      }

      return parsed.map(chapter => ({
        title: chapter.title || 'Untitled Chapter',
        startTime: Number(chapter.startTime) || 0,
        endTime: Number(chapter.endTime) || 0,
        description: chapter.description
      }));
    } catch (error) {
      console.error('Failed to parse chapters:', error);
      return [];
    }
  }

  private mergeOverlappingDetections(detections: AdDetection[]): AdDetection[] {
    if (detections.length === 0) return [];

    const sorted = [...detections].sort((a, b) => a.startTime - b.startTime);
    const merged: AdDetection[] = [];
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      
      // Merge if overlapping or very close (within 5 seconds)
      if (next.startTime <= current.endTime + 5) {
        current = {
          ...current,
          endTime: Math.max(current.endTime, next.endTime),
          confidence: Math.max(current.confidence, next.confidence),
          description: current.description || next.description
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    
    merged.push(current);
    return merged;
  }

  private mergeAdjacentChapters(chapters: Chapter[]): Chapter[] {
    if (chapters.length === 0) return [];

    const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);
    const merged: Chapter[] = [];
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      
      // Merge if very close and similar titles
      if (next.startTime - current.endTime <= 30 && this.areTitlesSimilar(current.title, next.title)) {
        current = {
          ...current,
          endTime: next.endTime,
          description: current.description || next.description
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    
    merged.push(current);
    return merged;
  }

  private areTitlesSimilar(title1: string, title2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const norm1 = normalize(title1);
    const norm2 = normalize(title2);
    return norm1.includes(norm2) || norm2.includes(norm1);
  }

  private getAdDetectionPrompt(transcript: string): string {
    return `Analyze this podcast transcript segment and identify advertisements. Return a JSON array of ad segments.

For each ad found, provide:
- startTime: estimated start time in seconds (rough estimate based on position in text)
- endTime: estimated end time in seconds  
- confidence: confidence score (0.0-1.0)
- adType: "pre-roll", "mid-roll", "post-roll", or "embedded"
- description: brief description of the ad content

Look for:
- Sponsor mentions and brand names
- Product/service promotions
- Discount codes and special offers
- "This episode is brought to you by..."
- Sudden topic changes to commercial content
- Host reading advertising copy

Transcript segment:
${transcript}

Return only a valid JSON array. If no ads found, return [].`;
  }

  private getChapterGenerationPrompt(transcript: string): string {
    return `Analyze this podcast transcript segment and suggest chapter divisions. Return a JSON array of chapters.

For each chapter, provide:
- title: descriptive chapter title (1-6 words)
- startTime: start time in seconds (estimate based on position)
- endTime: end time in seconds
- description: brief description of chapter content (optional)

Guidelines:
- Focus on major topic changes and natural breaks
- Ensure chapters are at least 1-2 minutes long
- Use clear, descriptive titles
- Consider interview segments, topics, or story beats

Transcript segment:
${transcript}

Return only a valid JSON array.`;
  }

  private createDescriptionPrompt(original: string, chapters: Chapter[], adsRemoved: AdDetection[]): string {
    const chapterList = chapters.length > 0 
      ? `\n\nChapters:\n${chapters.map(ch => `• ${ch.title}`).join('\n')}`
      : '';
    
    const adNote = adsRemoved.length > 0
      ? `\n\n✂️ This episode has been processed to remove ${adsRemoved.length} advertisement(s).`
      : '';

    return `Please enhance this podcast description by keeping the original content and adding chapter information and ad removal notes:

Original Description:
${original}${chapterList}${adNote}

Create an enhanced version that:
1. Maintains the original description's tone and style
2. Incorporates the chapter information naturally
3. Notes the ad removal in a user-friendly way
4. Keeps it concise and engaging`;
  }

  private recordUsage(inputTokens: number, outputTokens: number, duration: number): void {
    // Simple cost calculation (example rates)
    const inputCost = (inputTokens / 1000) * 0.0015; // $0.0015 per 1K input tokens
    const outputCost = (outputTokens / 1000) * 0.002; // $0.002 per 1K output tokens
    const cost = inputCost + outputCost;

    this.totalUsage.inputTokens += inputTokens;
    this.totalUsage.outputTokens += outputTokens;
    this.totalUsage.cost += cost;
    this.totalUsage.duration += duration;

    console.log(`LLM usage: ${inputTokens} input + ${outputTokens} output tokens, $${cost.toFixed(4)}, ${duration}ms`);
    
    // Check cost limits
    if (this.totalUsage.cost > this.config.costLimits.maxCostPerEpisode) {
      console.warn(`Episode cost limit exceeded: $${this.totalUsage.cost.toFixed(4)} > $${this.config.costLimits.maxCostPerEpisode}`);
    }
  }

  getTotalUsage(): LLMUsage {
    return { ...this.totalUsage };
  }

  resetUsage(): void {
    this.totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      duration: 0
    };
  }
}