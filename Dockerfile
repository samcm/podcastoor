# Build stage
FROM node:18-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/processor/package.json ./packages/processor/

# Install dependencies (no lockfile since we're updating deps)
RUN pnpm install

# Copy all source code
COPY packages/shared ./packages/shared
COPY packages/processor ./packages/processor
COPY turbo.json ./
COPY config/ ./config/

# Build everything using turbo (handles dependencies)
RUN pnpm build

# Production stage
FROM node:18-alpine AS runtime

# Install necessary packages for audio processing
RUN apk add --no-cache \
    ffmpeg \
    curl \
    sqlite

# Install pnpm
RUN npm install -g pnpm

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S podcastoor -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/processor/package.json ./packages/processor/

# Install only production dependencies
RUN pnpm install --prod

# Copy built application
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/processor/dist ./packages/processor/dist
COPY --from=builder /app/config ./config

# Create necessary directories
RUN mkdir -p /app/data /app/tmp /app/config && \
    chown -R podcastoor:nodejs /app

# Switch to non-root user
USER podcastoor

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "packages/processor/dist/index.js"]