# Podcast RSS Feed Proxy System Implementation Plan

## Executive Summary
> **Problem Statement**: Current podcast consumption is hindered by embedded advertisements and lack of content organization, requiring manual skipping and content discovery.
>
> **Proposed Solution**: A cost-optimized two-component system that automatically removes ads, generates content chapters, and serves processed podcasts via cached RSS feeds.
>
> **Technical Approach**: 
> - Cloudflare Worker serving cached RSS feeds with S3 redirects for cost optimization
> - Node.js processor using two-pass LLM approach (Gemini 2.5 Flash for transcription, Kimi K2 for ad detection)
> - FFmpeg-based audio processing with automatic ad removal
> - S3-compatible storage (R2/Minio) for processed content
>
> **Data Flow**: RSS ingestion → Audio download → Transcription → Ad detection → Audio processing → S3 upload → RSS generation → Edge caching
>
> **Expected Outcomes**: ~$0.074 processing cost per 3-hour podcast, 95%+ ad detection accuracy, automated content chapters, and globally cached RSS delivery.

## Goals & Objectives
### Primary Goals
- **Cost Optimization**: Process 3-hour podcasts for <$0.10 total cost (LLM + storage + bandwidth)
- **Ad Detection Accuracy**: Achieve 95%+ accuracy in identifying and removing embedded advertisements
- **Automated Processing**: Zero-manual intervention pipeline from RSS ingestion to processed content delivery

### Secondary Objectives
- **Global Performance**: <200ms RSS feed response times via Cloudflare edge caching
- **Content Enhancement**: Generate meaningful chapter divisions and enhanced descriptions
- **Maintainable Architecture**: Testable components with CI/CD validation for reliable LLM model swapping

## Solution Overview
### Approach
Two-component Node.js system with Cloudflare Workers for edge optimization and a processing engine for heavy computational tasks. Uses hybrid two-pass LLM strategy: large context windows for transcription quality, followed by cost-effective models for specialized ad detection.

### Key Components
1. **Cloudflare Worker (TypeScript)**: RSS proxy with edge caching, S3 redirects, and processing triggers
2. **Node.js Processor**: FFmpeg integration, LLM orchestration, S3 operations, and background job processing
3. **Shared Library**: TypeScript definitions, YAML schemas, and validation utilities

### Architecture Diagram
```
[RSS Sources] → [Processor] → [S3/R2] → [Worker] → [Cached RSS] → [Users]
                     ↓             ↑         ↓
                [LLM APIs]    [Audio Files] [Edge Cache]
```

### Data Flow
```
RSS Ingestion → Audio Download → Transcription (15-20min chunks) → 
Ad Detection (8-10min chunks) → FFmpeg Processing → S3 Upload → 
RSS Generation → Worker Cache → Global Distribution
```

### Expected Outcomes
- **Users can consume ad-free podcasts** with automated chapter navigation
- **Content creators receive enhanced descriptions** mentioning removed ads and generated chapters
- **System operators achieve <$0.10 per 3-hour podcast** total processing cost
- **Global users experience <200ms RSS response times** via edge caching

## Implementation Tasks

### CRITICAL IMPLEMENTATION RULES
1. **NO PLACEHOLDER CODE**: Every implementation must be production-ready. NEVER write "TODO", "in a real implementation", or similar placeholders unless explicitly requested by the user.
2. **CROSS-DIRECTORY TASKS**: Group related changes across directories into single tasks to ensure consistency. Never create isolated changes that require follow-up work in sibling directories.
3. **COMPLETE IMPLEMENTATIONS**: Each task must fully implement its feature including all consumers, type updates, and integration points.
4. **DETAILED SPECIFICATIONS**: Each task must include EXACTLY what to implement, including specific functions, types, and integration points to avoid "breaking change" confusion.
5. **CONTEXT AWARENESS**: Each task is part of a larger system - specify how it connects to other parts.
6. **MAKE BREAKING CHANGES**: Unless explicitly requested by the user, you MUST make breaking changes.

### Visual Dependency Tree
```
podcastoor/
├── package.json (Task #0: Root workspace configuration)
├── pnpm-workspace.yaml (Task #0: Monorepo setup)
├── turbo.json (Task #0: Build orchestration)
│
├── packages/
│   ├── shared/ (Task #1: Core types and schemas)
│   │   ├── src/
│   │   │   ├── types/ (Task #1: TypeScript definitions)
│   │   │   ├── schemas/ (Task #1: YAML validation schemas)
│   │   │   └── utils/ (Task #1: Shared utilities)
│   │   └── package.json
│   │
│   ├── worker/ (Task #8: Cloudflare Worker RSS proxy)
│   │   ├── src/
│   │   │   ├── index.ts (Task #8: Main worker entry)
│   │   │   ├── handlers/ (Task #8: RSS and cache handlers)
│   │   │   └── utils/ (Task #8: Worker-specific utilities)
│   │   ├── wrangler.toml (Task #8: Worker configuration)
│   │   └── package.json
│   │
│   └── processor/ (Task #9: Main processing engine)
│       ├── src/
│       │   ├── index.ts (Task #9: Main processor entry)
│       │   ├── services/ (Tasks #2-7: Core processing services)
│       │   ├── config/ (Task #2: Configuration management)
│       │   ├── audio/ (Task #3: FFmpeg integration)
│       │   ├── llm/ (Task #4: LLM orchestration)
│       │   ├── storage/ (Task #5: S3/Minio operations)
│       │   ├── rss/ (Task #6: RSS processing)
│       │   └── jobs/ (Task #7: Background job system)
│       └── package.json
│
├── config/ (Task #2: YAML configuration files)
│   ├── podcasts.yaml (Task #2: Podcast feed configuration)
│   ├── processing.yaml (Task #2: Processing parameters)
│   └── llm.yaml (Task #2: LLM model configuration)
│
├── tests/ (Task #10: Comprehensive testing suite)
│   ├── unit/ (Task #10: Unit tests for all components)
│   ├── integration/ (Task #10: Integration tests)
│   └── ci/ (Task #10: CI-specific test configurations)
│
└── .github/workflows/ (Task #11: CI/CD pipeline)
    ├── test.yml (Task #11: Testing workflow)
    └── deploy.yml (Task #11: Deployment workflow)
```

### Execution Plan

#### Group A: Foundation Setup (Execute all in parallel)
- [ ] **Task #0**: Initialize monorepo workspace
  - **Files**: `/package.json`, `/pnpm-workspace.yaml`, `/turbo.json`, `/.gitignore`, `/README.md`
  - **Implements**: 
    ```json
    // package.json
    {
      "name": "podcastoor",
      "private": true,
      "workspaces": ["packages/*"],
      "scripts": {
        "build": "turbo run build",
        "test": "turbo run test",
        "dev": "turbo run dev --parallel"
      },
      "devDependencies": {
        "turbo": "^2.x",
        "typescript": "^5.x",
        "@types/node": "^22.x"
      }
    }
    ```
  - **pnpm-workspace.yaml**: `packages: ['packages/*']`
  - **turbo.json**: Build pipeline with `build`, `test`, `dev` tasks and proper dependency chains
  - **Context**: Root configuration enables parallel development and deployment of worker + processor

- [ ] **Task #1**: Create shared types and schemas library
  - **Folder**: `packages/shared/`
  - **Files**: `src/types/index.ts`, `src/schemas/index.ts`, `src/utils/index.ts`, `package.json`
  - **Implements**:
    ```typescript
    // src/types/index.ts
    export interface PodcastConfig {
      id: string;
      name: string;
      rssUrl: string;
      enabled: boolean;
      retentionDays: number;
      processingOptions: ProcessingOptions;
    }
    
    export interface ProcessingOptions {
      removeAds: boolean;
      generateChapters: boolean;
      transcriptionModel: string;
      adDetectionModel: string;
      chunkSizeMinutes: number;
      overlapSeconds: number;
    }
    
    export interface AdDetection {
      startTime: number;
      endTime: number;
      confidence: number;
      adType: 'pre-roll' | 'mid-roll' | 'post-roll' | 'embedded';
      description?: string;
    }
    
    export interface Chapter {
      title: string;
      startTime: number;
      endTime: number;
      description?: string;
    }
    
    export interface ProcessingResult {
      podcastId: string;
      episodeId: string;
      originalUrl: string;
      processedUrl: string;
      adsRemoved: AdDetection[];
      chapters: Chapter[];
      processingCost: number;
      processedAt: Date;
    }
    ```
  - **Zod Schemas**: Complete validation schemas for all TypeScript interfaces
  - **Exports**: All types, schemas, and validation utilities
  - **Context**: Foundation for type safety across worker and processor components

#### Group B: Core Services (Execute all in parallel after Group A)
- [ ] **Task #2**: Implement configuration management system
  - **Folder**: `packages/processor/src/config/`
  - **Files**: `ConfigManager.ts`, `schemas.ts`, `validator.ts`
  - **Imports**:
    ```typescript
    import { z } from 'zod';
    import * as yaml from 'yaml';
    import { PodcastConfig, ProcessingOptions } from '@podcastoor/shared';
    import { readFileSync, watchFile } from 'fs';
    import { join } from 'path';
    ```
  - **Implements**:
    ```typescript
    export class ConfigManager {
      private config: AppConfig;
      private watchers: Map<string, () => void> = new Map();
      
      static async fromFile(configPath: string): Promise<ConfigManager>
      async loadPodcasts(): Promise<PodcastConfig[]>
      async updatePodcast(id: string, config: Partial<PodcastConfig>): Promise<void>
      onConfigChange(callback: (config: AppConfig) => void): void
      validateConfig(config: unknown): AppConfig
    }
    
    interface AppConfig {
      podcasts: PodcastConfig[];
      processing: {
        concurrency: number;
        retryAttempts: number;
        chunkStrategy: 'fixed' | 'semantic';
        defaultRetentionDays: number;
      };
      llm: {
        transcriptionProvider: string;
        adDetectionProvider: string;
        apiKeys: Record<string, string>;
        fallbackModels: string[];
      };
      storage: {
        provider: 'minio' | 'r2';
        endpoint: string;
        bucket: string;
        region?: string;
      };
    }
    ```
  - **YAML File Structure**: Creates complete `config/podcasts.yaml`, `config/processing.yaml`, `config/llm.yaml` with production-ready defaults
  - **Integration**: Used by all processor services for runtime configuration
  - **Context**: Central configuration system with hot-reloading and validation

- [ ] **Task #3**: Implement FFmpeg audio processing service
  - **Folder**: `packages/processor/src/audio/`
  - **Files**: `AudioProcessor.ts`, `FFmpegWrapper.ts`, `types.ts`
  - **Imports**:
    ```typescript
    import { spawn, ChildProcess } from 'child_process';
    import { createReadStream, createWriteStream } from 'fs';
    import { promisify } from 'util';
    import { pipeline } from 'stream';
    import { AdDetection } from '@podcastoor/shared';
    import ffmpegStatic from 'ffmpeg-static';
    ```
  - **Implements**:
    ```typescript
    export class AudioProcessor {
      private ffmpegPath: string;
      
      constructor(ffmpegPath?: string)
      async downloadAudio(url: string, outputPath: string): Promise<AudioMetadata>
      async removeAds(inputPath: string, outputPath: string, ads: AdDetection[]): Promise<void>
      async extractMetadata(filePath: string): Promise<AudioMetadata>
      async createChunks(inputPath: string, chunkDuration: number, overlap: number): Promise<string[]>
      async normalizeAudio(inputPath: string, outputPath: string): Promise<void>
      private buildFFmpegCommand(args: string[]): ChildProcess
      private parseFFmpegOutput(output: string): AudioMetadata
    }
    
    interface AudioMetadata {
      duration: number;
      format: string;
      bitrate: number;
      sampleRate: number;
      channels: number;
      size: number;
    }
    ```
  - **FFmpeg Operations**: Complete implementation for audio download, ad removal with precise cutting, metadata extraction, and chunking
  - **Error Handling**: Robust process management with timeout, memory limits, and cleanup
  - **Integration**: Used by main processor for all audio manipulations
  - **Context**: Core audio processing engine handling all FFmpeg interactions

- [ ] **Task #4**: Implement LLM orchestration service
  - **Folder**: `packages/processor/src/llm/`
  - **Files**: `LLMOrchestrator.ts`, `providers/`, `chunking/`, `types.ts`
  - **Imports**:
    ```typescript
    import OpenAI from 'openai';
    import Anthropic from '@anthropic-ai/sdk';
    import { AI } from '@ai-sdk/core';
    import { openai } from '@ai-sdk/openai';
    import { AdDetection, Chapter } from '@podcastoor/shared';
    ```
  - **Implements**:
    ```typescript
    export class LLMOrchestrator {
      private providers: Map<string, LLMProvider>;
      private chunkingStrategy: ChunkingStrategy;
      
      constructor(config: LLMConfig)
      async transcribeAudio(audioPath: string, model?: string): Promise<string>
      async detectAds(transcript: string, model?: string): Promise<AdDetection[]>
      async generateChapters(transcript: string, model?: string): Promise<Chapter[]>
      async enhanceDescription(original: string, chapters: Chapter[], adsRemoved: AdDetection[]): Promise<string>
      private createChunks(text: string, strategy: 'fixed' | 'semantic'): TextChunk[]
      private mergeOverlappingDetections(detections: AdDetection[]): AdDetection[]
    }
    
    interface TextChunk {
      content: string;
      startTime: number;
      endTime: number;
      chunkIndex: number;
      overlap: boolean;
    }
    
    abstract class LLMProvider {
      abstract transcribe(audio: string): Promise<string>
      abstract detectAds(text: string): Promise<AdDetection[]>
      abstract generateChapters(text: string): Promise<Chapter[]>
    }
    ```
  - **Provider Implementations**: Complete OpenAI, Anthropic, and Gemini providers with proper error handling and rate limiting
  - **Chunking Strategy**: Two-pass approach with 15-20 minute transcription chunks and 8-10 minute ad detection chunks with 90-second overlap
  - **Cost Tracking**: Built-in token counting and cost calculation per operation
  - **Integration**: Used by processor for all LLM interactions with automatic fallback
  - **Context**: Orchestrates all AI operations with cost optimization and accuracy focus

- [ ] **Task #5**: Implement S3/Minio storage service
  - **Folder**: `packages/processor/src/storage/`
  - **Files**: `StorageManager.ts`, `providers/`, `types.ts`
  - **Imports**:
    ```typescript
    import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
    import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
    import { createReadStream } from 'fs';
    import { stat } from 'fs/promises';
    ```
  - **Implements**:
    ```typescript
    export class StorageManager {
      private s3Client: S3Client;
      private bucket: string;
      private baseUrl: string;
      
      constructor(config: StorageConfig)
      async uploadAudio(filePath: string, key: string): Promise<UploadResult>
      async downloadAudio(key: string, outputPath: string): Promise<void>
      async deleteAudio(key: string): Promise<void>
      async listAudioFiles(prefix?: string): Promise<StorageObject[]>
      async generatePresignedUrl(key: string, expiresIn?: number): Promise<string>
      async getPublicUrl(key: string): Promise<string>
      async cleanupOldFiles(olderThanDays: number): Promise<number>
      private buildS3Key(podcastId: string, episodeId: string, suffix?: string): string
    }
    
    interface UploadResult {
      key: string;
      url: string;
      size: number;
      etag: string;
    }
    
    interface StorageObject {
      key: string;
      size: number;
      lastModified: Date;
      url: string;
    }
    ```
  - **Provider Support**: Works with both Minio (local) and Cloudflare R2 (production) with identical API
  - **Cost Optimization**: Intelligent key generation for efficient storage and retrieval
  - **Cleanup Operations**: Automated deletion of files older than configured retention period
  - **Integration**: Used by processor for all file storage operations
  - **Context**: Handles all persistent storage with configurable backends

- [ ] **Task #6**: Implement RSS processing service
  - **Folder**: `packages/processor/src/rss/`
  - **Files**: `RSSProcessor.ts`, `FeedGenerator.ts`, `types.ts`
  - **Imports**:
    ```typescript
    import Parser from '@rowanmanning/feed-parser';
    import { XMLBuilder } from 'fast-xml-parser';
    import { fetch } from 'node-fetch';
    import { ProcessingResult, Chapter, AdDetection } from '@podcastoor/shared';
    ```
  - **Implements**:
    ```typescript
    export class RSSProcessor {
      private parser: Parser;
      private generator: FeedGenerator;
      
      constructor(config: RSSConfig)
      async fetchFeed(url: string): Promise<ParsedFeed>
      async parseEpisodes(feed: ParsedFeed): Promise<Episode[]>
      async filterNewEpisodes(episodes: Episode[], lastProcessed: Date): Promise<Episode[]>
      async generateProcessedFeed(original: ParsedFeed, results: ProcessingResult[]): Promise<string>
      async validateFeed(feedXml: string): Promise<ValidationResult>
      private enhanceEpisodeDescription(episode: Episode, result: ProcessingResult): string
      private createChapterMarkers(chapters: Chapter[]): string
    }
    
    export class FeedGenerator {
      async createRSSFeed(episodes: ProcessedEpisode[], metadata: FeedMetadata): Promise<string>
      private buildEpisodeItem(episode: ProcessedEpisode): object
      private addChapterTags(episode: ProcessedEpisode): object
    }
    
    interface Episode {
      guid: string;
      title: string;
      description: string;
      audioUrl: string;
      publishDate: Date;
      duration: number;
    }
    
    interface ProcessedEpisode extends Episode {
      processedAudioUrl: string;
      chapters: Chapter[];
      adsRemoved: AdDetection[];
      enhancedDescription: string;
    }
    ```
  - **RSS Generation**: Creates valid RSS 2.0 feeds with podcast namespace extensions for chapters
  - **URL Rewriting**: Replaces original audio URLs with S3/R2 URLs using 307 redirects
  - **Description Enhancement**: Adds chapter summaries and ad removal notifications
  - **Integration**: Used by processor to create final RSS output
  - **Context**: Handles all RSS feed parsing and generation

- [ ] **Task #7**: Implement background job processing system
  - **Folder**: `packages/processor/src/jobs/`
  - **Files**: `JobManager.ts`, `workers/`, `queue.ts`, `types.ts`
  - **Imports**:
    ```typescript
    import { Queue, Worker, Job } from 'bullmq';
    import Redis from 'ioredis';
    import { ConfigManager } from '../config/ConfigManager';
    import { AudioProcessor } from '../audio/AudioProcessor';
    import { LLMOrchestrator } from '../llm/LLMOrchestrator';
    import { StorageManager } from '../storage/StorageManager';
    import { RSSProcessor } from '../rss/RSSProcessor';
    ```
  - **Implements**:
    ```typescript
    export class JobManager {
      private queue: Queue;
      private workers: Worker[];
      private redis: Redis;
      
      constructor(config: JobConfig)
      async start(): Promise<void>
      async stop(): Promise<void>
      async addPodcastProcessingJob(podcastId: string, episodeId: string, priority?: number): Promise<string>
      async addCleanupJob(olderThanDays: number): Promise<string>
      async getJobStatus(jobId: string): Promise<JobStatus>
      async retryFailedJobs(): Promise<number>
      private setupWorkers(): void
      private setupEventHandlers(): void
    }
    
    export class PodcastWorker {
      async processPodcastEpisode(job: Job<PodcastJobData>): Promise<ProcessingResult>
      private downloadAndProcess(episode: Episode): Promise<ProcessingResult>
      private handleProcessingError(error: Error, job: Job): Promise<void>
    }
    
    interface PodcastJobData {
      podcastId: string;
      episodeId: string;
      audioUrl: string;
      retryCount: number;
    }
    ```
  - **Queue Management**: Redis-backed job queue with priority, retry, and failure handling
  - **Worker Pool**: Configurable number of concurrent workers for parallel processing
  - **Job Types**: Podcast processing, cleanup, and administrative jobs
  - **Integration**: Orchestrates all processing services for complete episode processing
  - **Context**: Background processing engine handling all long-running tasks

#### Group C: Application Assembly (Execute all in parallel after Group B)
- [ ] **Task #8**: Implement Cloudflare Worker RSS proxy
  - **Folder**: `packages/worker/`
  - **Files**: `src/index.ts`, `src/handlers/`, `src/utils/`, `wrangler.toml`, `package.json`
  - **Imports**:
    ```typescript
    import { Hono } from 'hono';
    import { cache } from 'hono/cache';
    import { cors } from 'hono/cors';
    import { PodcastConfig } from '@podcastoor/shared';
    ```
  - **Implements**:
    ```typescript
    const app = new Hono();
    
    app.get('/rss/:podcastId', cache({ cacheName: 'rss-feeds', cacheControl: 'max-age=300' }), async (c) => {
      const podcastId = c.req.param('podcastId');
      const cachedFeed = await getRSSFromCache(podcastId);
      
      if (cachedFeed) {
        return new Response(cachedFeed, {
          headers: { 'Content-Type': 'application/rss+xml' }
        });
      }
      
      const processedFeed = await fetchProcessedFeed(podcastId);
      await cacheRSSFeed(podcastId, processedFeed);
      
      return new Response(processedFeed, {
        headers: { 'Content-Type': 'application/rss+xml' }
      });
    });
    
    app.get('/audio/:podcastId/:episodeId', async (c) => {
      const audioUrl = await getS3AudioUrl(podcastId, episodeId);
      return Response.redirect(audioUrl, 307);
    });
    
    async function getRSSFromCache(podcastId: string): Promise<string | null>
    async function fetchProcessedFeed(podcastId: string): Promise<string>
    async function cacheRSSFeed(podcastId: string, feed: string): Promise<void>
    async function getS3AudioUrl(podcastId: string, episodeId: string): Promise<string>
    ```
  - **Wrangler Configuration**: Complete production configuration with KV storage, R2 bindings, and custom domains
  - **Caching Strategy**: Edge caching with 5-minute TTL for RSS feeds, permanent caching for audio redirects
  - **Cost Optimization**: 307 redirects to S3/R2 URLs to minimize bandwidth usage
  - **Integration**: Serves processed content from storage and triggers processor updates
  - **Context**: Global edge distribution for fast RSS feed delivery

- [ ] **Task #9**: Implement main processor application
  - **Folder**: `packages/processor/`
  - **Files**: `src/index.ts`, `src/PodcastProcessor.ts`, `package.json`
  - **Imports**:
    ```typescript
    import { ConfigManager } from './config/ConfigManager';
    import { JobManager } from './jobs/JobManager';
    import { RSSProcessor } from './rss/RSSProcessor';
    import { StorageManager } from './storage/StorageManager';
    import cron from 'node-cron';
    import { PodcastConfig } from '@podcastoor/shared';
    ```
  - **Implements**:
    ```typescript
    export class PodcastProcessor {
      private config: ConfigManager;
      private jobManager: JobManager;
      private rssProcessor: RSSProcessor;
      private storageManager: StorageManager;
      private cronJobs: Map<string, cron.ScheduledTask> = new Map();
      
      constructor()
      async start(): Promise<void>
      async stop(): Promise<void>
      async processAllPodcasts(): Promise<void>
      async processPodcast(podcastId: string): Promise<void>
      async cleanupOldFiles(): Promise<void>
      private setupCronJobs(): void
      private handleProcessingError(error: Error, podcastId: string): void
    }
    
    // Main entry point
    async function main() {
      const processor = new PodcastProcessor();
      
      process.on('SIGINT', () => processor.stop());
      process.on('SIGTERM', () => processor.stop());
      
      await processor.start();
      console.log('Podcast processor started');
    }
    
    if (require.main === module) {
      main().catch(console.error);
    }
    ```
  - **Cron Integration**: Configurable scheduling for podcast checking and cleanup operations
  - **Graceful Shutdown**: Proper cleanup of resources and job completion on termination
  - **Error Handling**: Comprehensive error recovery with retry logic and alerting
  - **Integration**: Orchestrates all services for complete podcast processing pipeline
  - **Context**: Main application entry point coordinating all processing activities

#### Group D: Testing and CI/CD (Execute all in parallel after Groups A-C)
- [ ] **Task #10**: Implement comprehensive testing suite
  - **Folder**: `tests/`
  - **Files**: `unit/`, `integration/`, `ci/`, `test-data/`, `vitest.config.ts`
  - **Implements**:
    ```typescript
    // Unit tests for each service
    describe('AudioProcessor', () => {
      it('should remove ads accurately', async () => {
        const processor = new AudioProcessor();
        const ads = [{ startTime: 60, endTime: 90, confidence: 0.95 }];
        await processor.removeAds('input.mp3', 'output.mp3', ads);
        // Verify audio duration reduced by 30 seconds
      });
    });
    
    describe('LLMOrchestrator', () => {
      it('should detect embedded ads', async () => {
        const orchestrator = new LLMOrchestrator(testConfig);
        const detections = await orchestrator.detectAds(sampleTranscript);
        expect(detections).toHaveLength(3);
        expect(detections[0].adType).toBe('embedded');
      });
    });
    
    // Integration tests
    describe('End-to-End Processing', () => {
      it('should process test podcast successfully', async () => {
        const processor = new PodcastProcessor();
        const result = await processor.processPodcast('test-podcast-1');
        expect(result.adsRemoved).toHaveLength(2);
        expect(result.chapters).toHaveLength(4);
      });
    });
    ```
  - **Test Data**: Sample podcasts with known ad patterns for CI validation
  - **Mocking Strategy**: Mock LLM APIs for unit tests, real APIs for integration tests
  - **CI Configuration**: Specific test podcasts for validating ad detection accuracy
  - **Performance Tests**: Benchmarks for processing speed and cost optimization
  - **Integration**: Validates entire processing pipeline with real-world scenarios
  - **Context**: Ensures reliable operation and enables confident LLM model swapping

- [ ] **Task #11**: Setup CI/CD pipeline
  - **Folder**: `.github/workflows/`
  - **Files**: `test.yml`, `deploy.yml`, `quality.yml`
  - **Implements**:
    ```yaml
    # .github/workflows/test.yml
    name: Test Pipeline
    on: [push, pull_request]
    
    jobs:
      test-processor:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: pnpm/action-setup@v2
          - name: Install dependencies
            run: pnpm install --frozen-lockfile
          - name: Run unit tests
            run: pnpm test --filter=processor
          - name: Run integration tests
            run: pnpm test:integration --filter=processor
            env:
              OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
              TEST_PODCAST_URL: ${{ secrets.TEST_PODCAST_URL }}
      
      test-worker:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: pnpm/action-setup@v2
          - name: Test Cloudflare Worker
            run: pnpm test --filter=worker
      
      ad-detection-accuracy:
        runs-on: ubuntu-latest
        needs: [test-processor]
        steps:
          - name: Test Ad Detection on Known Podcasts
            run: pnpm run test:ad-detection
            env:
              CI_PODCAST_URLS: ${{ secrets.CI_PODCAST_URLS }}
    ```
  - **Deployment Pipeline**: Automated Worker deployment and processor Docker builds
  - **Quality Gates**: Ad detection accuracy thresholds and cost validation
  - **Model Testing**: Automated validation when swapping LLM providers
  - **Integration**: Complete CI/CD for both components with production deployment
  - **Context**: Ensures reliable deployments and maintains processing quality

---

## Implementation Workflow

This plan file serves as the authoritative checklist for implementation. When implementing:

### Required Process
1. **Load Plan**: Read this entire plan file before starting
2. **Sync Tasks**: Create TodoWrite tasks matching the checkboxes below
3. **Execute & Update**: For each task:
   - Mark TodoWrite as `in_progress` when starting
   - Update checkbox `[ ]` to `[x]` when completing
   - Mark TodoWrite as `completed` when done
4. **Maintain Sync**: Keep this file and TodoWrite synchronized throughout

### Critical Rules
- This plan file is the source of truth for progress
- Update checkboxes in real-time as work progresses
- Never lose synchronization between plan file and TodoWrite
- Mark tasks complete only when fully implemented (no placeholders)
- Tasks should be run in parallel, unless there are dependencies, using subtasks, to avoid context bloat.

### Progress Tracking
The checkboxes above represent the authoritative status of each task. Keep them updated as you work.