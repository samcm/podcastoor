import { z } from 'zod';

export function validateConfig<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }
  return result.data;
}

// Export new shared utilities
export * from './errors';
export * from './time';
export * from './validation';

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function generateEpisodeId(title: string, publishDate: Date): string {
  const cleanTitle = title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
  
  const dateStr = publishDate.toISOString().split('T')[0];
  return `${dateStr}-${cleanTitle}`;
}

export function calculateProcessingCost(
  transcriptionMinutes: number,
  adDetectionMinutes: number,
  transcriptionCostPerMinute: number = 0.006,
  adDetectionCostPerMinute: number = 0.002
): number {
  return (transcriptionMinutes * transcriptionCostPerMinute) + 
         (adDetectionMinutes * adDetectionCostPerMinute);
}