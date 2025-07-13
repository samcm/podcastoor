export { CacheManager } from './cache.js';

export function validatePodcastId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 100;
}

export function validateEpisodeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 100;
}

export function formatError(message: string, code?: string): { error: string; code?: string } {
  return { error: message, code };
}

export function parseUserAgent(userAgent: string): { bot: boolean; client: string } {
  const botPatterns = [
    /bot/i, /crawler/i, /spider/i, /scraper/i,
    /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i
  ];
  
  const isBot = botPatterns.some(pattern => pattern.test(userAgent));
  
  return {
    bot: isBot,
    client: userAgent.split('/')[0] || 'unknown'
  };
}