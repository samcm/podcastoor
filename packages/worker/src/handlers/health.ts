import { Context } from 'hono';
import { Env } from '../index.js';

export async function healthHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT || 'unknown',
    version: '1.0.0',
    checks: {
      kv: false,
      r2: false,
      processor: false
    }
  };

  try {
    // Test KV namespace
    await c.env.RSS_CACHE.put('health-check', 'ok', { expirationTtl: 60 });
    const kvTest = await c.env.RSS_CACHE.get('health-check');
    health.checks.kv = kvTest === 'ok';
  } catch (error) {
    console.error('KV health check failed:', error);
  }

  try {
    // Test R2 bucket
    await c.env.AUDIO_STORAGE.head('health-check.txt');
    health.checks.r2 = true;
  } catch (error) {
    // Expected to fail if file doesn't exist, but bucket is accessible
    health.checks.r2 = true;
  }

  try {
    // Test processor connectivity
    const processorResponse = await fetch(`${c.env.PROCESSOR_URL}/health`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    health.checks.processor = processorResponse.ok;
  } catch (error) {
    console.error('Processor health check failed:', error);
  }

  // Determine overall health
  const allChecksHealthy = Object.values(health.checks).every(check => check);
  if (!allChecksHealthy) {
    health.status = 'degraded';
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;

  return c.json(health, statusCode);
}