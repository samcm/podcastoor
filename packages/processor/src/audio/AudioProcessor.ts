import { spawn, ChildProcess } from 'child_process';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { join, dirname } from 'path';
import { AdDetection, AudioMetadata } from '@podcastoor/shared';

const pipelineAsync = promisify(pipeline);

export interface AudioProcessingOptions {
  tempDirectory: string;
  ffmpegPath?: string;
  maxDuration?: number;
  timeoutMs?: number;
}

export class AudioProcessor {
  private ffmpegPath: string;
  private tempDirectory: string;
  private maxDuration: number;
  private timeoutMs: number;

  constructor(options: AudioProcessingOptions) {
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.tempDirectory = options.tempDirectory;
    this.maxDuration = options.maxDuration || 14400; // 4 hours
    this.timeoutMs = options.timeoutMs || 3600000; // 1 hour
  }

  async downloadAudio(url: string, episodeGuid: string): Promise<string> {
    const outputPath = join(this.tempDirectory, `${episodeGuid}_original.mp3`);
    await this.downloadAudioToPath(url, outputPath);
    return outputPath;
  }

  async downloadAudioToPath(url: string, outputPath: string): Promise<AudioMetadata> {
    await this.ensureDirectoryExists(dirname(outputPath));

    const args = [
      '-i', url,
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      '-y', // Overwrite output file
      outputPath
    ];

    try {
      await this.runFFmpeg(args, `Downloading audio from ${url}`);
      return await this.extractMetadata(outputPath);
    } catch (error) {
      throw new Error(`Failed to download audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async removeAds(inputPath: string, ads: AdDetection[]): Promise<string> {
    const outputPath = inputPath.replace('_original.mp3', '_processed.mp3');
    await this.removeAdsToPath(inputPath, outputPath, ads);
    return outputPath;
  }

  async extractAdSegments(inputPath: string, ads: AdDetection[], episodeGuid: string): Promise<string[]> {
    if (ads.length === 0) {
      return [];
    }

    const adPaths: string[] = [];
    
    // Sort ads by start time
    const sortedAds = [...ads].sort((a, b) => a.startTime - b.startTime);
    
    try {
      for (let i = 0; i < sortedAds.length; i++) {
        const ad = sortedAds[i];
        const adDuration = ad.endTime - ad.startTime;
        
        // Skip very short segments (< 1 second)
        if (adDuration < 1) {
          console.warn(`Skipping ad segment ${i + 1}: duration too short (${adDuration}s)`);
          continue;
        }
        
        const adFileName = `${episodeGuid}_ad_${i + 1}_${ad.adType}.mp3`;
        const adPath = join(this.tempDirectory, adFileName);
        
        console.log(`Extracting ad segment ${i + 1}: ${ad.startTime}s - ${ad.endTime}s (${ad.adType})`);
        
        await this.extractSegment(inputPath, adPath, ad.startTime, adDuration);
        adPaths.push(adPath);
      }
      
      console.log(`Extracted ${adPaths.length} ad segments`);
      return adPaths;
    } catch (error) {
      // Clean up any successfully extracted files on error
      await Promise.all(adPaths.map(path => 
        fs.unlink(path).catch((err: unknown) => console.warn(`Failed to cleanup ad file ${path}:`, err))
      ));
      throw new Error(`Failed to extract ad segments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async removeAdsToPath(inputPath: string, outputPath: string, ads: AdDetection[]): Promise<void> {
    if (ads.length === 0) {
      // No ads to remove, just copy the file
      await fs.copyFile(inputPath, outputPath);
      return;
    }

    await this.ensureDirectoryExists(dirname(outputPath));

    // Sort ads by start time
    const sortedAds = [...ads].sort((a, b) => a.startTime - b.startTime);
    
    // Create segments between ads
    const segments = this.createSegmentList(sortedAds, await this.extractMetadata(inputPath));
    
    if (segments.length === 0) {
      throw new Error('No valid segments found after ad removal');
    }

    // Create temporary segment files
    const segmentFiles: string[] = [];
    
    try {
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentFile = join(this.tempDirectory, `segment_${i}_${Date.now()}.mp3`);
        
        await this.extractSegment(inputPath, segmentFile, segment.start, segment.duration);
        segmentFiles.push(segmentFile);
      }

      // Concatenate segments
      await this.concatenateSegments(segmentFiles, outputPath);
      
    } finally {
      // Clean up temporary files
      await Promise.all(segmentFiles.map(file => 
        fs.unlink(file).catch((err: unknown) => console.warn(`Failed to delete temp file ${file}:`, err))
      ));
    }
  }

  async extractMetadata(filePath: string): Promise<AudioMetadata> {
    const args = [
      '-i', filePath,
      '-f', 'null',
      '-'
    ];

    try {
      const output = await this.runFFmpeg(args, `Extracting metadata from ${filePath}`);
      return this.parseFFmpegOutput(output);
    } catch (error) {
      throw new Error(`Failed to extract metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createChunks(inputPath: string, chunkDuration: number, overlap: number): Promise<string[]> {
    const metadata = await this.extractMetadata(inputPath);
    const chunks: string[] = [];
    
    let currentTime = 0;
    let chunkIndex = 0;

    while (currentTime < metadata.duration) {
      const chunkPath = join(this.tempDirectory, `chunk_${chunkIndex}_${Date.now()}.mp3`);
      const actualDuration = Math.min(chunkDuration * 60, metadata.duration - currentTime);
      
      await this.extractSegment(inputPath, chunkPath, currentTime, actualDuration);
      chunks.push(chunkPath);
      
      currentTime += (chunkDuration * 60) - overlap;
      chunkIndex++;
    }

    return chunks;
  }

  async normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
    await this.ensureDirectoryExists(dirname(outputPath));

    const args = [
      '-i', inputPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-y',
      outputPath
    ];

    try {
      await this.runFFmpeg(args, `Normalizing audio ${inputPath}`);
    } catch (error) {
      throw new Error(`Failed to normalize audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async extractSegment(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
    const args = [
      '-i', inputPath,
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-acodec', 'copy',
      '-y',
      outputPath
    ];

    await this.runFFmpeg(args, `Extracting segment from ${startTime}s for ${duration}s`);
  }

  private async concatenateSegments(segmentFiles: string[], outputPath: string): Promise<void> {
    // Create concat file list
    const concatFile = join(this.tempDirectory, `concat_${Date.now()}.txt`);
    const concatContent = segmentFiles.map(file => `file '${file}'`).join('\n');
    
    await fs.writeFile(concatFile, concatContent, 'utf8');

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      '-y',
      outputPath
    ];

    try {
      await this.runFFmpeg(args, `Concatenating ${segmentFiles.length} segments`);
    } finally {
      await fs.unlink(concatFile).catch((err: unknown) => 
        console.warn(`Failed to delete concat file ${concatFile}:`, err)
      );
    }
  }

  private createSegmentList(ads: AdDetection[], metadata: AudioMetadata): Array<{start: number, duration: number}> {
    const segments: Array<{start: number, duration: number}> = [];
    let currentTime = 0;

    for (const ad of ads) {
      // Add segment before ad (if there's content)
      if (ad.startTime > currentTime) {
        segments.push({
          start: currentTime,
          duration: ad.startTime - currentTime
        });
      }
      
      // Skip the ad content
      currentTime = ad.endTime;
    }

    // Add final segment after last ad
    if (currentTime < metadata.duration) {
      segments.push({
        start: currentTime,
        duration: metadata.duration - currentTime
      });
    }

    // Filter out segments that are too short (< 1 second)
    return segments.filter(segment => segment.duration >= 1);
  }

  private async runFFmpeg(args: string[], description: string): Promise<string> {
    return new Promise((resolve, reject) => {
      console.log(`FFmpeg: ${description}`);
      console.log(`Command: ${this.ffmpegPath} ${args.join(' ')}`);

      const process = spawn(this.ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error(`FFmpeg process timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      process.on('close', (code: number | null) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve(stderr); // FFmpeg outputs info to stderr
        } else {
          reject(new Error(`FFmpeg process exited with code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start FFmpeg process: ${error.message}`));
      });
    });
  }

  private parseFFmpegOutput(output: string): AudioMetadata {
    const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    const bitrateMatch = output.match(/bitrate: (\d+) kb\/s/);
    const formatMatch = output.match(/Audio: ([^,]+)/);
    const sampleRateMatch = output.match(/(\d+) Hz/);
    const channelsMatch = output.match(/(\d+) channels?/);
    const sizeMatch = output.match(/size=\s*(\d+)kB/);

    if (!durationMatch) {
      throw new Error('Could not parse duration from FFmpeg output');
    }

    const hours = parseInt(durationMatch[1], 10);
    const minutes = parseInt(durationMatch[2], 10);
    const seconds = parseFloat(durationMatch[3]);
    const duration = hours * 3600 + minutes * 60 + seconds;

    return {
      duration,
      format: formatMatch ? formatMatch[1].trim() : 'unknown',
      bitrate: bitrateMatch ? parseInt(bitrateMatch[1], 10) : 0,
      sampleRate: sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 0,
      channels: channelsMatch ? parseInt(channelsMatch[1], 10) : 0,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) * 1024 : 0 // Convert KB to bytes
    };
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async cleanup(filePath?: string): Promise<void> {
    if (filePath) {
      // Clean up specific file
      try {
        await fs.unlink(filePath);
        console.log(`Cleaned up file: ${filePath}`);
      } catch (error) {
        console.warn(`Failed to cleanup file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // Clean up temporary files older than 1 hour
    try {
      const files = await fs.readdir(this.tempDirectory);
      const now = Date.now();
      const maxAge = 60 * 60 * 1000; // 1 hour

      for (const file of files) {
        const filePath = join(this.tempDirectory, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup temp directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}