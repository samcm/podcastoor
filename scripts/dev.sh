#!/bin/bash

# Development script for running Podcastoor locally (no Docker required)

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Podcastoor development environment...${NC}"

# Check required environment variables
if [ -z "$GEMINI_API_KEY" ]; then
    echo -e "${YELLOW}Warning: GEMINI_API_KEY environment variable not set${NC}"
    echo "Please set it: export GEMINI_API_KEY=your_key_here"
    exit 1
fi

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Create necessary directories in project root
mkdir -p "$PROJECT_ROOT/data" "$PROJECT_ROOT/tmp" "$PROJECT_ROOT/storage"

# Run the processor in development mode
echo -e "${GREEN}Starting Podcastoor processor...${NC}"
echo -e "${YELLOW}Note: This runs locally without Docker. Storage is local filesystem-based.${NC}"

# Set the config path to the root config directory using absolute path
export CONFIG_PATH="$PROJECT_ROOT/config"
export CONFIG_FILE="config.yaml"
export DATABASE_PATH="$PROJECT_ROOT/data/podcastoor.db"
export TEMP_DIR="$PROJECT_ROOT/tmp"
export STORAGE_BASE_DIR="$PROJECT_ROOT/storage"
export PUBLIC_URL="${PUBLIC_URL:-http://localhost:5173}"

# Run from packages/processor
cd "$PROJECT_ROOT/packages/processor"
pnpm dev