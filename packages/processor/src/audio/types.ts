export interface AudioChunk {
  filePath: string;
  startTime: number;
  endTime: number;
  duration: number;
  chunkIndex: number;
  hasOverlap: boolean;
}

export interface AudioSegment {
  start: number;
  duration: number;
  isAd: boolean;
  confidence?: number;
}

export interface ProcessingProgress {
  stage: 'download' | 'analyze' | 'process' | 'upload';
  percentage: number;
  currentFile?: string;
  estimatedTimeRemaining?: number;
}

export interface AudioQualitySettings {
  format: 'mp3' | 'aac' | 'ogg';
  bitrate: number;
  sampleRate: number;
  channels: 1 | 2;
  normalize: boolean;
  compressionLevel?: number;
}

export interface AudioProcessingResult {
  inputFile: string;
  outputFile: string;
  originalDuration: number;
  processedDuration: number;
  adsRemoved: number;
  processingTime: number;
  fileSize: {
    original: number;
    processed: number;
  };
}

export interface AudioValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  metadata?: {
    duration: number;
    format: string;
    bitrate: number;
    sampleRate: number;
    channels: number;
  };
}