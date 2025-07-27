import { createReadStream, promises as fs, createWriteStream, existsSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { pipeline } from 'stream';
import { ProcessingArtifacts } from '@podcastoor/shared';

export interface StorageConfig {
  baseDirectory: string;
  publicUrl?: string;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  etag: string;
}

export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date;
  url: string;
}

export class StorageManager {
  private baseDirectory: string;
  private publicUrl: string;
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    this.baseDirectory = config.baseDirectory;
    this.publicUrl = config.publicUrl || 'http://localhost:3000/files';
    
    // Ensure base directory exists
    mkdirSync(this.baseDirectory, { recursive: true });
  }

  async uploadAudioFile(podcastId: string, episodeGuid: string, filePath: string): Promise<string> {
    const result = await this.uploadAudio(filePath, podcastId, episodeGuid);
    return result.url;
  }

  async uploadAdSegment(filePath: string, podcastId: string, episodeId: string, adIndex: number, adType: string): Promise<UploadResult> {
    const fileName = basename(filePath);
    const key = this.buildAdSegmentKey(podcastId, episodeId, adIndex, adType);
    
    console.log(`Uploading ad segment: ${filePath} -> ${key}`);
    
    try {
      const targetPath = join(this.baseDirectory, key);
      await this.ensureDirectoryExists(dirname(targetPath));
      
      const fileStats = await fs.stat(filePath);
      
      // Copy file to storage location
      await fs.copyFile(filePath, targetPath);
      
      const url = this.getPublicUrl(key);
      const etag = this.generateEtag(targetPath, fileStats.size);
      
      console.log(`Ad segment upload completed: ${key} (${fileStats.size} bytes)`);
      
      return {
        key,
        url,
        size: fileStats.size,
        etag
      };
    } catch (error) {
      throw new Error(`Failed to upload ad segment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadAudio(filePath: string, podcastId: string, episodeId: string): Promise<UploadResult> {
    const fileName = basename(filePath);
    const key = this.buildFileKey(podcastId, episodeId, fileName);
    
    console.log(`Uploading audio file: ${filePath} -> ${key}`);
    
    try {
      const targetPath = join(this.baseDirectory, key);
      await this.ensureDirectoryExists(dirname(targetPath));
      
      const fileStats = await fs.stat(filePath);
      
      // Copy file to storage location
      await fs.copyFile(filePath, targetPath);
      
      const url = this.getPublicUrl(key);
      const etag = this.generateEtag(targetPath, fileStats.size);
      
      console.log(`Upload completed: ${key} (${fileStats.size} bytes)`);
      
      return {
        key,
        url,
        size: fileStats.size,
        etag
      };
    } catch (error) {
      throw new Error(`Failed to upload audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadRSSFeed(podcastId: string, feedContent: string): Promise<UploadResult> {
    const key = `rss/${podcastId}.xml`;
    
    console.log(`Uploading RSS feed: ${podcastId} -> ${key}`);
    
    try {
      const targetPath = join(this.baseDirectory, key);
      await this.ensureDirectoryExists(dirname(targetPath));
      
      const buffer = Buffer.from(feedContent, 'utf8');
      
      // Write RSS content to file
      await fs.writeFile(targetPath, buffer);
      
      const url = this.getPublicUrl(key);
      const etag = this.generateEtag(targetPath, buffer.length);
      
      console.log(`RSS feed upload completed: ${key} (${buffer.length} bytes)`);
      
      return {
        key,
        url,
        size: buffer.length,
        etag
      };
    } catch (error) {
      throw new Error(`Failed to upload RSS feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadProcessingArtifacts(podcastId: string, episodeId: string, artifacts: ProcessingArtifacts): Promise<UploadResult> {
    const key = this.buildArtifactKey(podcastId, episodeId);
    
    console.log(`Uploading processing artifacts: ${podcastId}/${episodeId} -> ${key}`);
    
    try {
      const targetPath = join(this.baseDirectory, key);
      await this.ensureDirectoryExists(dirname(targetPath));
      
      const artifactData = JSON.stringify(artifacts, null, 2);
      const buffer = Buffer.from(artifactData, 'utf8');
      
      // Write artifacts to file
      await fs.writeFile(targetPath, buffer);
      
      const url = this.getPublicUrl(key);
      const etag = this.generateEtag(targetPath, buffer.length);
      
      console.log(`Processing artifacts upload completed: ${key} (${buffer.length} bytes)`);
      
      return {
        key,
        url,
        size: buffer.length,
        etag
      };
    } catch (error) {
      throw new Error(`Failed to upload processing artifacts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getRSSFeedUrl(podcastId: string): Promise<string> {
    const key = `rss/${podcastId}.xml`;
    return this.getPublicUrl(key);
  }

  async getRSSFeedContent(podcastId: string): Promise<string | null> {
    const key = `rss/${podcastId}.xml`;
    const filePath = join(this.baseDirectory, key);
    
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      return content;
    } catch (error) {
      throw new Error(`Failed to retrieve RSS feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getProcessingArtifacts(podcastId: string, episodeId: string): Promise<ProcessingArtifacts | null> {
    const key = this.buildArtifactKey(podcastId, episodeId);
    const filePath = join(this.baseDirectory, key);
    
    console.log(`Retrieving processing artifacts: ${podcastId}/${episodeId} from ${key}`);
    
    try {
      if (!existsSync(filePath)) {
        console.log(`Processing artifacts not found: ${key}`);
        return null;
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      const artifacts = JSON.parse(content);
      
      console.log(`Processing artifacts retrieved: ${key}`);
      return artifacts;
    } catch (error) {
      throw new Error(`Failed to retrieve processing artifacts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getProcessingArtifactsUrl(podcastId: string, episodeId: string): Promise<string> {
    const key = this.buildArtifactKey(podcastId, episodeId);
    return this.getPublicUrl(key);
  }

  async downloadAudio(key: string, outputPath: string): Promise<void> {
    console.log(`Downloading audio file: ${key} -> ${outputPath}`);
    
    try {
      const sourcePath = join(this.baseDirectory, key);
      
      if (!existsSync(sourcePath)) {
        throw new Error(`File not found: ${key}`);
      }
      
      // Ensure output directory exists
      await this.ensureDirectoryExists(dirname(outputPath));
      
      // Copy file to output path
      await fs.copyFile(sourcePath, outputPath);
      
      console.log(`Download completed: ${key}`);
    } catch (error) {
      throw new Error(`Failed to download audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteAudio(key: string): Promise<void> {
    console.log(`Deleting audio file: ${key}`);
    
    try {
      const filePath = join(this.baseDirectory, key);
      
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
        console.log(`Deletion completed: ${key}`);
      } else {
        console.log(`File not found for deletion: ${key}`);
      }
    } catch (error) {
      throw new Error(`Failed to delete audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteRSSFeed(podcastId: string): Promise<void> {
    const key = `rss/${podcastId}.xml`;
    console.log(`Deleting RSS feed: ${key}`);
    
    try {
      const filePath = join(this.baseDirectory, key);
      
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
        console.log(`RSS feed deletion completed: ${key}`);
      } else {
        console.log(`RSS feed not found for deletion: ${key}`);
      }
    } catch (error) {
      throw new Error(`Failed to delete RSS feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listAudioFiles(prefix?: string): Promise<StorageObject[]> {
    console.log(`Listing audio files with prefix: ${prefix || 'all'}`);
    
    try {
      const searchDir = prefix ? join(this.baseDirectory, prefix) : this.baseDirectory;
      const objects: StorageObject[] = [];
      
      if (!existsSync(searchDir)) {
        return objects;
      }
      
      const files = await this.getAllFilesRecursively(searchDir);
      
      for (const filePath of files) {
        try {
          const stats = await fs.stat(filePath);
          const relativePath = filePath.replace(this.baseDirectory + '/', '').replace(this.baseDirectory + '\\', '');
          const key = relativePath.replace(/\\/g, '/'); // Normalize path separators
          
          objects.push({
            key,
            size: stats.size,
            lastModified: stats.mtime,
            url: this.getPublicUrl(key)
          });
        } catch (error) {
          console.error(`Error reading file stats for ${filePath}:`, error);
        }
      }
      
      console.log(`Found ${objects.length} audio files`);
      return objects;
    } catch (error) {
      throw new Error(`Failed to list audio files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async generatePresignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    console.log(`Generating presigned URL for: ${key} (expires in ${expiresIn}s)`);
    
    // For local storage, we just return the public URL since we don't have presigning
    return this.getPublicUrl(key);
  }

  getPublicUrl(key: string): string {
    // Clean up the key to remove any leading slashes
    const cleanKey = key.replace(/^\/+/, '');
    return `${this.publicUrl}/${cleanKey}`;
  }

  async cleanupOldFiles(olderThanDays: number): Promise<number> {
    console.log(`Cleaning up files older than ${olderThanDays} days`);
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    try {
      const allFiles = await this.listAudioFiles();
      const filesToDelete = allFiles.filter(file => file.lastModified < cutoffDate);
      
      console.log(`Found ${filesToDelete.length} files to delete`);
      
      let deletedCount = 0;
      for (const file of filesToDelete) {
        try {
          await this.deleteAudio(file.key);
          deletedCount++;
        } catch (error) {
          console.error(`Failed to delete file ${file.key}:`, error);
        }
      }
      
      console.log(`Cleanup completed: ${deletedCount} files deleted`);
      return deletedCount;
    } catch (error) {
      throw new Error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fileExists(key: string): Promise<boolean> {
    try {
      const filePath = join(this.baseDirectory, key);
      return existsSync(filePath);
    } catch (error) {
      return false;
    }
  }

  async getFileMetadata(key: string): Promise<{size: number, lastModified: Date, contentType: string} | null> {
    try {
      const filePath = join(this.baseDirectory, key);
      
      if (!existsSync(filePath)) {
        return null;
      }
      
      const stats = await fs.stat(filePath);
      
      // Determine content type based on file extension
      let contentType = 'application/octet-stream';
      if (key.endsWith('.mp3')) {
        contentType = 'audio/mpeg';
      } else if (key.endsWith('.xml')) {
        contentType = 'application/rss+xml';
      } else if (key.endsWith('.json')) {
        contentType = 'application/json';
      }
      
      return {
        size: stats.size,
        lastModified: stats.mtime,
        contentType
      };
    } catch (error) {
      return null;
    }
  }

  private buildFileKey(podcastId: string, episodeId: string, suffix?: string): string {
    const datePath = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const cleanEpisodeId = episodeId.replace(/[^a-zA-Z0-9-_]/g, '-');
    
    if (suffix) {
      return `podcasts/${podcastId}/${datePath}/${cleanEpisodeId}/${suffix}`;
    }
    
    return `podcasts/${podcastId}/${datePath}/${cleanEpisodeId}`;
  }

  private buildArtifactKey(podcastId: string, episodeId: string): string {
    const cleanEpisodeId = episodeId.replace(/[^a-zA-Z0-9-_]/g, '-');
    return `artifacts/${podcastId}/${cleanEpisodeId}/processing-data.json`;
  }

  private buildAdSegmentKey(podcastId: string, episodeId: string, adIndex: number, adType: string): string {
    const datePath = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const cleanEpisodeId = episodeId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const cleanAdType = adType.replace(/[^a-zA-Z0-9-_]/g, '-');
    
    return `podcasts/${podcastId}/${datePath}/${cleanEpisodeId}/ads/ad_${adIndex}_${cleanAdType}.mp3`;
  }

  getBucketName(): string {
    return 'local-storage';
  }

  getEndpoint(): string {
    return this.publicUrl;
  }

  getBaseDirectory(): string {
    return this.baseDirectory;
  }

  async deleteProcessedFiles(podcastId: string, episodeId: string): Promise<void> {
    console.log(`Deleting processed files for ${podcastId}/${episodeId}`);
    
    try {
      // List all files for this episode
      const prefix = `podcasts/${podcastId}`;
      const allFiles = await this.listAudioFiles(prefix);
      
      const cleanEpisodeId = episodeId.replace(/[^a-zA-Z0-9-_]/g, '-');
      const episodeFiles = allFiles.filter(obj => obj.key.includes(cleanEpisodeId));
      
      for (const file of episodeFiles) {
        await this.deleteAudio(file.key);
      }
      
      console.log(`Deleted ${episodeFiles.length} files for episode ${episodeId}`);
    } catch (error) {
      throw new Error(`Failed to delete processed files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Test if we can access the base directory
      const stats = await fs.stat(this.baseDirectory);
      return stats.isDirectory();
    } catch (error) {
      console.error('Storage connection test failed:', error);
      return false;
    }
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      if ((error as any).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  private async getAllFilesRecursively(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          const subFiles = await this.getAllFilesRecursively(fullPath);
          files.push(...subFiles);
        } else {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error);
    }
    
    return files;
  }

  private generateEtag(filePath: string, size: number): string {
    // Generate a simple etag based on file path and size
    // In a real implementation, you might want to use a hash of the file content
    const timestamp = new Date().getTime();
    return `"${size}-${timestamp}"`;
  }
}