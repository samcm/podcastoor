import { Request, Response } from 'express';
import { Database } from '../database/Database';
import { StorageManager } from '../storage/StorageManager';
import { createReadStream, existsSync, promises as fs } from 'fs';
import { join } from 'path';

export class AudioProxyService {
  constructor(
    private db: Database,
    private storage: StorageManager
  ) {}
  
  async proxyAudio(req: Request, res: Response): Promise<void> {
    const { episodeGuid } = req.params;
    
    try {
      // Get episode details
      const details = this.db.getEpisodeDetails(episodeGuid);
      
      if (!details || !details.episode) {
        res.status(404).json({ error: 'Episode not found' });
        return;
      }
      
      // Check if processed
      if (details.processedEpisode?.processedUrl) {
        // Stream from local storage
        await this.streamProcessedAudio(details.processedEpisode.processedUrl, req, res);
      } else {
        // Redirect to original
        res.redirect(307, details.episode.audioUrl);
      }
    } catch (error) {
      console.error('Audio proxy error:', error);
      res.status(500).json({ error: 'Failed to serve audio' });
    }
  }
  
  private async streamProcessedAudio(url: string, req: Request, res: Response): Promise<void> {
    try {
      // Extract the file key from the URL
      const urlParts = new URL(url);
      const key = urlParts.pathname.replace('/files/', '');
      
      // Get the file path from storage manager
      const filePath = this.getLocalFilePath(key);
      
      if (!existsSync(filePath)) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }
      
      // Get file metadata
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      
      // Handle range requests for seeking/partial content
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
        
        const stream = createReadStream(filePath, { start, end });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=3600'
        });
        
        const stream = createReadStream(filePath);
        stream.pipe(res);
      }
    } catch (error) {
      console.error('Streaming error:', error);
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  }

  private getLocalFilePath(key: string): string {
    // Get the base directory from storage manager
    const baseDirectory = this.storage.getBaseDirectory();
    return join(baseDirectory, key);
  }
}