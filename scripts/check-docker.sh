#!/bin/bash
# Health check script for Docker deployment

set -e

echo "🐳 Checking Podcastoor Docker deployment..."

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose not found. Please install Docker Compose."
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please copy .env.example to .env and configure it."
    exit 1
fi

# Check if required API keys are set
source .env
if [ -z "$GEMINI_API_KEY" ] || [ "$GEMINI_API_KEY" = "your_gemini_api_key_here" ]; then
    echo "❌ GEMINI_API_KEY not set in .env file"
    exit 1
fi

if [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "your_openrouter_api_key_here" ]; then
    echo "❌ OPENROUTER_API_KEY not set in .env file"
    exit 1
fi

echo "✅ Environment configuration looks good"

# Check if services are running
echo "🔍 Checking service status..."

if ! docker-compose ps | grep -q "Up"; then
    echo "⚠️  Services don't appear to be running. Starting them..."
    docker-compose up -d
    echo "⏳ Waiting for services to start..."
    sleep 30
fi

# Check MinIO health
echo "🗄️  Checking MinIO..."
if curl -f -s http://localhost:9000/minio/health/live > /dev/null; then
    echo "✅ MinIO is healthy"
else
    echo "❌ MinIO health check failed"
    exit 1
fi

# Check processor health
echo "🎧 Checking Processor..."
if curl -f -s http://localhost:3000/health > /dev/null; then
    echo "✅ Processor is healthy"
    
    # Get detailed stats
    echo "📊 Processor Stats:"
    curl -s http://localhost:3000/health | python3 -m json.tool
else
    echo "❌ Processor health check failed"
    echo "📋 Recent processor logs:"
    docker-compose logs --tail=20 processor
    exit 1
fi

echo ""
echo "🎉 All services are running correctly!"
echo ""
echo "🌐 Available endpoints:"
echo "   MinIO Console: http://localhost:9001 (minioadmin/minioadmin123)"
echo "   Processor API: http://localhost:3000"
echo "   Health Check:  http://localhost:3000/health"
echo ""
echo "📁 Data locations:"
echo "   Database: ./data/podcastoor.db"
echo "   Temp files: ./tmp/"
echo "   Config: ./config/"
echo ""
echo "🔧 Useful commands:"
echo "   View logs: docker-compose logs -f processor"
echo "   Restart:   docker-compose restart"
echo "   Stop:      docker-compose down"