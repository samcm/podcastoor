export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PodcastoorError extends Error {
  constructor(message: string, public code: string, public details?: any) {
    super(message);
    this.name = 'PodcastoorError';
  }
}
