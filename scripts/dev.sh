#!/bin/bash

# Development script for running Podcastoor locally with Docker services

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Podcastoor development environment...${NC}"

# Load development environment variables
if [ -f .env.development ]; then
    export $(cat .env.development | grep -v '^#' | xargs)
else
    echo -e "${YELLOW}Warning: .env.development not found. Please create it from .env.development.example${NC}"
    exit 1
fi

# Check if Docker services are running
if ! docker compose -f docker-compose.dev.yml ps | grep -q "podcastoor-minio.*Up"; then
    echo -e "${GREEN}Starting Docker services (MinIO)...${NC}"
    docker compose -f docker-compose.dev.yml up -d
    
    # Wait for MinIO to be healthy
    echo "Waiting for MinIO to be ready..."
    until docker compose -f docker-compose.dev.yml ps | grep -q "podcastoor-minio.*healthy"; do
        sleep 1
    done
    echo -e "${GREEN}MinIO is ready!${NC}"
fi

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Create necessary directories in project root
mkdir -p "$PROJECT_ROOT/data" "$PROJECT_ROOT/tmp"

# Run the processor in development mode
echo -e "${GREEN}Starting Podcastoor processor...${NC}"

# Set the config path to the root config directory using absolute path
export CONFIG_PATH="$PROJECT_ROOT/config"
export CONFIG_FILE="config.dev.yaml"
export DATABASE_PATH="$PROJECT_ROOT/data/podcastoor.db"
export TEMP_DIR="$PROJECT_ROOT/tmp"

# Run from packages/processor
cd "$PROJECT_ROOT/packages/processor"
pnpm dev