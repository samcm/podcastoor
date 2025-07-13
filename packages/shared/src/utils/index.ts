import { z } from 'zod';

export function validateConfig<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }
  return result.data;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

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