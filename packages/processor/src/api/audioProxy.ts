import { Request, Response } from 'express';
import { DatabaseService } from '../services/database';
import { StorageManager } from '../storage/StorageManager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export class AudioProxyService {
  constructor(
    private db: DatabaseService,
    private storage: StorageManager
  ) {}
  
  async proxyAudio(req: Request, res: Response): Promise<void> {
    const { episodeGuid } = req.params;
    
    try {
      // Get episode details
      const details = await this.db.getEpisodeDetails(episodeGuid);
      
      if (!details.upstream) {
        res.status(404).json({ error: 'Episode not found' });
        return;
      }
      
      // Check if processed
      if (details.result?.processedAudioUrl) {
        // Stream from S3/Minio
        await this.streamProcessedAudio(details.result.processedAudioUrl, req, res);
      } else {
        // Redirect to original
        res.redirect(307, details.upstream.audioUrl);
      }
    } catch (error) {
      console.error('Audio proxy error:', error);
      res.status(500).json({ error: 'Failed to serve audio' });
    }
  }
  
  private async streamProcessedAudio(url: string, req: Request, res: Response): Promise<void> {
    try {
      // Parse S3 URL to get bucket and key
      const urlParts = new URL(url);
      const pathParts = urlParts.pathname.substring(1).split('/');
      const bucket = pathParts[0];
      const key = pathParts.slice(1).join('/');
      
      // Get object metadata
      const metadata = await this.getObjectMetadata(bucket, key);
      const fileSize = metadata.ContentLength || 0;
      
      // Handle range requests
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=3600'
        });
        
        const stream = await this.getObjectStream(bucket, key, { start, end });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=3600'
        });
        
        const stream = await this.getObjectStream(bucket, key);
        stream.pipe(res);
      }
    } catch (error) {
      console.error('Streaming error:', error);
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  }

  private async getObjectMetadata(bucket: string, key: string): Promise<any> {
    // This is a simplified implementation
    // In a real implementation, you'd use HeadObjectCommand
    return { ContentLength: 0 };
  }

  private async getObjectStream(bucket: string, key: string, range?: { start: number; end: number }): Promise<any> {
    // This is a simplified implementation
    // In a real implementation, you'd create a proper S3 object stream
    // For now, we'll return a mock stream
    const mockStream = {
      pipe: (response: Response) => {
        response.end('Mock audio stream');
      }
    };
    return mockStream;
  }
}