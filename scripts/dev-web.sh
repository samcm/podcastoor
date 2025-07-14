#!/bin/bash

# Development script for running the web frontend

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Podcastoor web frontend...${NC}"

# Load development environment variables
if [ -f .env.development ]; then
    export $(cat .env.development | grep -v '^#' | xargs)
else
    echo -e "${YELLOW}Warning: .env.development not found. Please create it from .env.development.example${NC}"
    exit 1
fi

# Run the web frontend
echo -e "${GREEN}Starting web development server...${NC}"
cd packages/web
pnpm dev