export class CacheManager {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key);
  }

  async set(key: string, value: string, ttl: number = 300): Promise<void> {
    await this.kv.put(key, value, {
      expirationTtl: ttl
    });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<number> {
    // KV doesn't support pattern deletion, so we'd need to track keys
    // This is a simplified implementation
    console.log(`Would invalidate cache pattern: ${pattern}`);
    return 0;
  }

  generateKey(type: string, id: string, ...parts: string[]): string {
    return [type, id, ...parts].join(':');
  }
}