export interface ServerConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
}

export interface StorageConfig {
  dataDir: string;
}

export interface ProcessingConfig {
  lookbackDays: number;
  maxEpisodesPerRun: number;
  concurrency: number;
  dryRun: boolean;
  downloadAudio: boolean;
  force: boolean;
  confidenceThreshold: number;
  preserveUnknownSegments: boolean;
}

export interface AutomationConfig {
  enabled: boolean;
  processOnStartup: boolean;
  intervalMinutes: number;
}

export interface CostConfig {
  monthlyBudgetUsd: number;
  perRunBudgetUsd: number;
  transcribeMaxMinutesPerRun: number;
  llmMaxInputTokensPerRun: number;
  llmMaxOutputTokensPerRun: number;
}

export interface JingleConfig {
  enabled: boolean;
  frequencyHz: number;
  durationSeconds: number;
  gainDb: number;
}

export interface AudioConfig {
  outputBitrateKbps: number;
  preserveSourceQuality: boolean;
  jingle: JingleConfig;
}

export interface TranscriptProviderConfig {
  preferred: "feed" | "openai" | "openRouter" | "pocketCasts";
  providers: {
    feed: { enabled: boolean };
    pocketCasts: {
      enabled: boolean;
      experimental: boolean;
      endpointTemplate: string;
    };
    openRouter: {
      enabled: boolean;
      model: string;
      language: string;
      chunkSeconds: number;
      concurrency: number;
      estimatedCostPerMinuteUsd: number;
    };
    openai: {
      enabled: boolean;
      model: string;
      estimatedCostPerMinuteUsd: number;
    };
  };
}

export interface LlmConfig {
  provider: "openrouter" | "none";
  enabled: boolean;
  model: string;
  estimatedInputUsdPerMillion: number;
  estimatedOutputUsdPerMillion: number;
  maxTranscriptChars: number;
}

export interface LlmUsage {
  provider: "openrouter";
  purpose: "ad-detection" | "chapter-generation";
  model: string;
  generationId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface DetectionConfig {
  paddingSeconds: number;
  minSegmentSeconds: number;
  maxSegmentSeconds: number;
}

export interface CategoryConfig {
  preferred: string[];
  muted: string[];
}

export interface PodcastOverride {
  name: string;
  feedUrl: string;
  lookbackDays?: number;
  maxEpisodesPerRun?: number;
  detection?: Partial<DetectionConfig>;
  categories?: Partial<CategoryConfig>;
  transcripts?: Partial<TranscriptProviderConfig>;
  llm?: Partial<LlmConfig>;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  processing: ProcessingConfig;
  automation: AutomationConfig;
  costs: CostConfig;
  audio: AudioConfig;
  transcripts: TranscriptProviderConfig;
  llm: LlmConfig;
  detection: DetectionConfig;
  categories: CategoryConfig;
  podcasts: Record<string, PodcastOverride>;
}

export interface EffectivePodcastConfig extends PodcastOverride {
  slug: string;
  processing: ProcessingConfig;
  detection: DetectionConfig;
  categories: CategoryConfig;
  transcripts: TranscriptProviderConfig;
  llm: LlmConfig;
}

export interface Enclosure {
  url: string;
  length?: number;
  type?: string;
}

export interface FeedTranscriptRef {
  url: string;
  type: string;
  language?: string;
  rel?: string;
}

export interface Chapter {
  startTime: number;
  title: string;
  url?: string;
  img?: string;
}

export interface ParsedEpisode {
  raw: unknown;
  key: string;
  guid: string;
  title: string;
  description: string;
  link?: string;
  pubDate?: Date;
  durationSeconds?: number;
  enclosure?: Enclosure;
  transcripts: FeedTranscriptRef[];
  chapters: Chapter[];
  podcastChaptersUrl?: string;
  sourceFingerprint: string;
}

export interface ParsedFeed {
  rawDoc: Record<string, unknown>;
  xml: string;
  title: string;
  feedUrl: string;
  episodes: ParsedEpisode[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface Transcript {
  source: string;
  format: string;
  language?: string;
  text: string;
  segments: TranscriptSegment[];
  usage?: {
    provider: "openrouter" | "openai" | "local" | "feed" | "pocketCasts";
    model?: string;
    seconds?: number;
    costUsd?: number;
  };
}

export type SegmentAction = "remove" | "keep" | "mark-only";

export interface SegmentDecision {
  start: number;
  end: number;
  action: SegmentAction;
  confidence: number;
  reason: string;
  source: "transcript-rule" | "description-rule" | "model" | "manual";
  alignment?: {
    startSegmentIndex?: number;
    endSegmentIndex?: number;
    method: "stt-chunk" | "feed-transcript-segment" | "manual";
  };
  text?: string;
}

export interface DetectionResult {
  decisions: SegmentDecision[];
  untimedSignals: string[];
  modelNotes?: string[];
  chapters?: Chapter[];
  llmUsage?: LlmUsage[];
}

export interface AudioRenderResult {
  status: "completed" | "dry-run" | "skipped";
  sourcePath?: string;
  processedPath?: string;
  bytes?: number;
  sourceDurationSeconds?: number;
  durationSeconds?: number;
  removedSeconds: number;
  jingleInsertedCount: number;
  renderMode?: "source-copy" | "encode" | "dry-run";
  codec?: string;
  bitrateKbps?: number;
}

export interface EpisodeManifest {
  schemaVersion: 1;
  pipelineVersion: string;
  processingSignature: string;
  podcastSlug: string;
  podcastName: string;
  episodeKey: string;
  title: string;
  guid: string;
  sourceUrl?: string;
  sourceFingerprint: string;
  pubDate?: string;
  originalDurationSeconds?: number;
  processedDurationSeconds?: number;
  decisions: SegmentDecision[];
  untimedSignals: string[];
  modelNotes?: string[];
  chapters: Chapter[];
  transcript?: {
    source: string;
    format: string;
    path?: string;
    segmentCount: number;
    model?: string;
    seconds?: number;
    costUsd?: number;
  };
  llm?: LlmUsage[];
  audio: AudioRenderResult;
  costs: {
    estimatedUsd: number;
    actualUsd: number;
    notes: string[];
  };
  generatedAt: string;
}

export interface ProcessingOptions {
  configPath: string;
  dryRun?: boolean;
  force?: boolean;
  downloadAudio?: boolean;
  podcastSlug?: string;
  maxEpisodes?: number;
}
