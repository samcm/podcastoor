# Podcastoor Docker Management

.PHONY: help setup start stop restart logs build check clean reset

# Default target
help: ## Show this help message
	@echo "Podcastoor Docker Management"
	@echo "=========================="
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Initial setup - install dependencies
	@echo "📦 Installing dependencies..."
	pnpm install
	@echo "🔨 Building packages..."
	pnpm build
	@echo "✅ Setup complete!"
	@echo "ℹ️  Set GEMINI_API_KEY environment variable before running"

start: ## Start all services
	@echo "🚀 Starting Podcastoor services..."
	docker-compose up -d
	@echo "⏳ Waiting for services to be ready..."
	@sleep 10
	@$(MAKE) check

stop: ## Stop all services
	@echo "🛑 Stopping Podcastoor services..."
	docker-compose down

restart: ## Restart all services
	@echo "🔄 Restarting Podcastoor services..."
	docker-compose restart

logs: ## Show processor logs
	docker-compose logs -f processor

logs-all: ## Show all service logs
	docker-compose logs -f

build: ## Build and start services (after code changes)
	@echo "🔨 Building and starting services..."
	docker-compose up --build -d
	@echo "⏳ Waiting for services to be ready..."
	@sleep 15
	@$(MAKE) check

check: ## Check service health
	@./scripts/check-docker.sh

clean: ## Remove containers and networks (keeps volumes)
	@echo "🧹 Cleaning up containers and networks..."
	docker-compose down --remove-orphans

reset: ## Complete reset - removes everything including data
	@echo "⚠️  This will destroy ALL data including the database!"
	@read -p "Are you sure? [y/N] " -n 1 -r; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		echo ""; \
		echo "🗑️  Removing all containers, networks, and volumes..."; \
		docker-compose down -v --remove-orphans; \
		docker volume prune -f; \
		rm -rf data/* tmp/*; \
		echo "✅ Reset complete"; \
	else \
		echo ""; \
		echo "❌ Reset cancelled"; \
	fi

status: ## Show service status
	@echo "📊 Service Status:"
	@docker-compose ps

shell: ## Open shell in processor container
	docker-compose exec processor sh

minio: ## Open MinIO console in browser
	@echo "🌐 Opening MinIO console..."
	@which open >/dev/null 2>&1 && open http://localhost:9001 || echo "Please open http://localhost:9001 in your browser"

api: ## Test API endpoints
	@echo "🔍 Testing API endpoints..."
	@echo "Health Check:"
	@curl -s http://localhost:3000/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/health
	@echo ""
	@echo "Stats:"
	@curl -s http://localhost:3000/api/stats | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/api/stats

# Development shortcuts
dev: build ## Alias for build (development mode)
up: start ## Alias for start
down: stop ## Alias for stop