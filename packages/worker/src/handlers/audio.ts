import { Context } from 'hono';
import { Env } from '../index.js';

export async function audioHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const podcastId = c.req.param('podcastId');
  const episodeId = c.req.param('episodeId');
  
  if (!podcastId || !episodeId) {
    return c.text('Missing podcast ID or episode ID', 400);
  }

  console.log(`Audio request for: ${podcastId}/${episodeId}`);

  try {
    // Check if processed audio exists in R2
    const audioKey = `podcasts/${podcastId}/${episodeId}.mp3`;
    const audioObject = await c.env.AUDIO_STORAGE.head(audioKey);
    
    if (audioObject) {
      // Generate R2 public URL or presigned URL
      const audioUrl = await getAudioUrl(c.env.AUDIO_STORAGE, audioKey);
      
      console.log(`Redirecting to processed audio: ${audioUrl}`);
      
      return Response.redirect(audioUrl, 307); // Temporary redirect
    }

    // If no processed audio, try to get original from processor
    const originalUrl = await getOriginalAudioUrl(c.env.PROCESSOR_URL, podcastId, episodeId);
    
    if (originalUrl) {
      console.log(`Redirecting to original audio: ${originalUrl}`);
      return Response.redirect(originalUrl, 307);
    }

    return c.text('Audio not found', 404);

  } catch (error) {
    console.error(`Audio handler error for ${podcastId}/${episodeId}:`, error);
    return c.text('Failed to fetch audio', 500);
  }
}

async function getAudioUrl(storage: R2Bucket, key: string): Promise<string> {
  // For public buckets, construct direct URL
  // For private buckets, this would generate a presigned URL
  return `https://pub-${storage.name}.r2.dev/${key}`;
}

async function getOriginalAudioUrl(processorUrl: string, podcastId: string, episodeId: string): Promise<string | null> {
  try {
    const url = `${processorUrl}/api/audio/${podcastId}/${episodeId}`;
    console.log(`Fetching original audio URL from: ${url}`);
    
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Podcastoor-Worker/1.0'
      }
    });

    if (!response.ok) {
      console.error(`Processor responded with status: ${response.status}`);
      return null;
    }

    // Get the redirect URL from the Location header
    const location = response.headers.get('Location');
    if (location) {
      return location;
    }

    return response.url;
  } catch (error) {
    console.error('Failed to fetch original audio URL:', error);
    return null;
  }
}