# Podcastoor

A cost-optimized podcast RSS proxy system that automatically removes ads, generates content chapters, and serves processed podcasts via globally cached RSS feeds.

## Architecture

- **Cloudflare Worker**: RSS proxy with edge caching and S3 redirects
- **Node.js Processor**: FFmpeg integration, LLM orchestration, and background job processing
- **Shared Library**: TypeScript definitions, YAML schemas, and validation utilities

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run in development mode
pnpm dev
```

## Processing Cost

- Target: <$0.10 per 3-hour podcast
- Two-pass LLM approach for cost optimization
- Automated ad detection with 95%+ accuracy

## Packages

- `@podcastoor/shared` - Common types and schemas
- `@podcastoor/worker` - Cloudflare Worker RSS proxy
- `@podcastoor/processor` - Main processing engine