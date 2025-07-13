import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { join, basename } from 'path';

export interface StorageConfig {
  provider: 'minio' | 'r2';
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  settings: {
    publicRead: boolean;
    presignedExpiry: number;
    multipartThreshold: string;
    maxConcurrentUploads: number;
  };
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
  private s3Client: S3Client;
  private bucket: string;
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    this.bucket = config.bucket;
    
    this.s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || 'auto',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.provider === 'minio', // Required for MinIO
    });
  }

  async uploadAudio(filePath: string, podcastId: string, episodeId: string): Promise<UploadResult> {
    const fileName = basename(filePath);
    const key = this.buildS3Key(podcastId, episodeId, fileName);
    
    console.log(`Uploading audio file: ${filePath} -> ${key}`);
    
    try {
      const fileStats = await fs.stat(filePath);
      const fileStream = createReadStream(filePath);
      
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileStream,
        ContentType: 'audio/mpeg',
        ContentLength: fileStats.size,
        ACL: this.config.settings.publicRead ? 'public-read' : 'private',
        Metadata: {
          'podcast-id': podcastId,
          'episode-id': episodeId,
          'uploaded-at': new Date().toISOString(),
          'original-filename': fileName
        }
      });

      const response = await this.s3Client.send(command);
      
      const url = await this.getPublicUrl(key);
      
      console.log(`Upload completed: ${key} (${fileStats.size} bytes)`);
      
      return {
        key,
        url,
        size: fileStats.size,
        etag: response.ETag || ''
      };
    } catch (error) {
      throw new Error(`Failed to upload audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadAudio(key: string, outputPath: string): Promise<void> {
    console.log(`Downloading audio file: ${key} -> ${outputPath}`);
    
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      
      if (!response.Body) {
        throw new Error('No data received from S3');
      }

      // Ensure output directory exists
      await fs.mkdir(join(outputPath, '..'), { recursive: true });
      
      // Stream the response body to file
      const writeStream = createWriteStream(outputPath);
      await pipeline(response.Body as any, writeStream);
      
      console.log(`Download completed: ${key}`);
    } catch (error) {
      throw new Error(`Failed to download audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteAudio(key: string): Promise<void> {
    console.log(`Deleting audio file: ${key}`);
    
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      console.log(`Deletion completed: ${key}`);
    } catch (error) {
      throw new Error(`Failed to delete audio file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listAudioFiles(prefix?: string): Promise<StorageObject[]> {
    console.log(`Listing audio files with prefix: ${prefix || 'all'}`);
    
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1000
      });

      const response = await this.s3Client.send(command);
      const objects: StorageObject[] = [];
      
      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key && obj.Size && obj.LastModified) {
            objects.push({
              key: obj.Key,
              size: obj.Size,
              lastModified: obj.LastModified,
              url: await this.getPublicUrl(obj.Key)
            });
          }
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
    
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresIn
      });
      
      return url;
    } catch (error) {
      throw new Error(`Failed to generate presigned URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getPublicUrl(key: string): Promise<string> {
    if (this.config.settings.publicRead) {
      // For public-read objects, construct direct URL
      return `${this.config.endpoint}/${this.bucket}/${key}`;
    } else {
      // Generate presigned URL for private objects
      return this.generatePresignedUrl(key, this.config.settings.presignedExpiry);
    }
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
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getFileMetadata(key: string): Promise<{size: number, lastModified: Date, contentType: string} | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      
      return {
        size: response.ContentLength || 0,
        lastModified: response.LastModified || new Date(),
        contentType: response.ContentType || 'application/octet-stream'
      };
    } catch (error) {
      return null;
    }
  }

  private buildS3Key(podcastId: string, episodeId: string, suffix?: string): string {
    const datePath = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const cleanEpisodeId = episodeId.replace(/[^a-zA-Z0-9-_]/g, '-');
    
    if (suffix) {
      return `podcasts/${podcastId}/${datePath}/${cleanEpisodeId}/${suffix}`;
    }
    
    return `podcasts/${podcastId}/${datePath}/${cleanEpisodeId}`;
  }

  getBucketName(): string {
    return this.bucket;
  }

  getEndpoint(): string {
    return this.config.endpoint;
  }

  async testConnection(): Promise<boolean> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        MaxKeys: 1
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      console.error('Storage connection test failed:', error);
      return false;
    }
  }
}