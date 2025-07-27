# Podcastoor

RSS proxy that removes ads from podcasts using AI-powered audio processing.

## Features
- Automatic ad detection and removal
- Chapter generation with timestamps
- Global RSS feed caching
- Cost-optimized processing

## Quick Start

### Local Development (No Docker Required)
```bash
# 1. Setup environment
npm run setup

# 2. Add your API keys to .env.development
# Edit .env.development and add your GEMINI_API_KEY

# 3. Start processor
npm run dev:local

# 4. Start web UI (in another terminal)
npm run dev:web
```

### Docker Deployment
```bash
docker compose up -d
```

### Development with Docker Services
```bash
# Use this if you need MinIO for S3-compatible storage testing
npm run dev:docker
```
