# Podcastoor

A cost-optimized podcast RSS proxy system that automatically removes ads, generates content chapters, and serves processed podcasts via globally cached RSS feeds.

## Architecture

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

## Packages

- `@podcastoor/shared` - Common types and schemas
- `@podcastoor/processor` - Main processing engine