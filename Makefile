# Wallet E2E Tests Makefile
#
# Usage:
#   make test                     # Run against localhost:3000/8080
#   make setup-local              # Start servers from local repos
#   make setup-git                # Clone repos and start servers
#   make ci                       # Full CI run (clone, build, test)

.PHONY: help install test test-headed test-debug test-ui \
        setup setup-local setup-local-quick setup-git setup-docker \
        teardown clean check-servers \
        clone-frontend clone-backend clone-all

# Configuration
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080
FRONTEND_PATH ?= ../wallet-frontend
BACKEND_PATH ?= ../go-wallet-backend

# Git repository settings
FRONTEND_REPO ?= https://github.com/wwWallet/wallet-frontend.git
FRONTEND_REF ?= master
BACKEND_REPO ?= https://github.com/sirosfoundation/go-wallet-backend.git
BACKEND_REF ?= main
WORKSPACE_DIR ?= .workspace

# Colors
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

help: ## Show this help
	@echo "Wallet E2E Tests"
	@echo ""
	@echo "Configuration:"
	@echo "  FRONTEND_URL  = $(FRONTEND_URL)"
	@echo "  BACKEND_URL   = $(BACKEND_URL)"
	@echo "  FRONTEND_REF  = $(FRONTEND_REF)"
	@echo "  BACKEND_REF   = $(BACKEND_REF)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-18s$(NC) %s\n", $$1, $$2}'

# =============================================================================
# Installation
# =============================================================================

install: ## Install dependencies and Playwright
	@echo "$(GREEN)Installing dependencies...$(NC)"
	npm install
	npx playwright install chromium
	@echo "$(GREEN)Ready!$(NC)"

# =============================================================================
# Test Execution
# =============================================================================

test: ## Run all tests
	@echo "$(GREEN)Running tests...$(NC)"
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test

test-headed: ## Run tests with visible browser
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --headed

test-debug: ## Run tests with debugger
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --debug

test-ui: ## Open Playwright UI
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --ui

test-prf: ## Run PRF tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --grep "@prf"

test-registration: ## Run registration tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --grep "@registration"

test-login: ## Run login tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) npx playwright test --grep "@login"

# =============================================================================
# Server Setup
# =============================================================================

setup: install check-servers ## Verify servers are running
	@echo "$(GREEN)Ready to test!$(NC)"

setup-local: install ## Start servers from local repos
	@if [ ! -d "$(FRONTEND_PATH)" ]; then \
		echo "$(RED)Frontend not found: $(FRONTEND_PATH)$(NC)"; exit 1; fi
	@if [ ! -d "$(BACKEND_PATH)" ]; then \
		echo "$(RED)Backend not found: $(BACKEND_PATH)$(NC)"; exit 1; fi
	./scripts/setup-local.sh --frontend-path "$(FRONTEND_PATH)" --backend-path "$(BACKEND_PATH)"

setup-local-quick: install ## Start servers (skip npm install)
	@if [ ! -d "$(FRONTEND_PATH)" ]; then \
		echo "$(RED)Frontend not found: $(FRONTEND_PATH)$(NC)"; exit 1; fi
	@if [ ! -d "$(BACKEND_PATH)" ]; then \
		echo "$(RED)Backend not found: $(BACKEND_PATH)$(NC)"; exit 1; fi
	./scripts/setup-local.sh --frontend-path "$(FRONTEND_PATH)" --backend-path "$(BACKEND_PATH)" --skip-install

setup-docker: install ## Start servers using Docker
	docker-compose up -d --wait
	@echo "$(GREEN)Containers started!$(NC)"

# =============================================================================
# Git-based Setup (clone repos)
# =============================================================================

clone-frontend: ## Clone wallet-frontend at FRONTEND_REF
	@mkdir -p $(WORKSPACE_DIR)
	@if [ -d "$(WORKSPACE_DIR)/wallet-frontend" ]; then \
		cd $(WORKSPACE_DIR)/wallet-frontend && git fetch --all && git checkout $(FRONTEND_REF); \
	else \
		git clone $(FRONTEND_REPO) $(WORKSPACE_DIR)/wallet-frontend && \
		cd $(WORKSPACE_DIR)/wallet-frontend && git checkout $(FRONTEND_REF); \
	fi
	@echo "$(GREEN)Frontend at $(FRONTEND_REF)$(NC)"

clone-backend: ## Clone go-wallet-backend at BACKEND_REF
	@mkdir -p $(WORKSPACE_DIR)
	@if [ -d "$(WORKSPACE_DIR)/go-wallet-backend" ]; then \
		cd $(WORKSPACE_DIR)/go-wallet-backend && git fetch --all && git checkout $(BACKEND_REF); \
	else \
		git clone $(BACKEND_REPO) $(WORKSPACE_DIR)/go-wallet-backend && \
		cd $(WORKSPACE_DIR)/go-wallet-backend && git checkout $(BACKEND_REF); \
	fi
	@echo "$(GREEN)Backend at $(BACKEND_REF)$(NC)"

clone-all: clone-frontend clone-backend ## Clone both repos

setup-git: install clone-all ## Clone repos and start servers
	@echo "$(GREEN)Installing frontend dependencies...$(NC)"
	@cd $(WORKSPACE_DIR)/wallet-frontend && npm install --legacy-peer-deps
	@cd $(WORKSPACE_DIR)/go-wallet-backend && go build ./...
	./scripts/setup-local.sh \
		--frontend-path "$(WORKSPACE_DIR)/wallet-frontend" \
		--backend-path "$(WORKSPACE_DIR)/go-wallet-backend" \
		--skip-install

# =============================================================================
# CI Target (single command to run everything)
# =============================================================================

ci: install clone-all ## Full CI: clone, build, test (with cleanup)
	@echo "$(GREEN)Building...$(NC)"
	cd $(WORKSPACE_DIR)/wallet-frontend && npm install --legacy-peer-deps
	cd $(WORKSPACE_DIR)/go-wallet-backend && go build ./cmd/server/...
	@echo "$(GREEN)Starting servers...$(NC)"
	cd $(WORKSPACE_DIR)/go-wallet-backend && \
		RP_ORIGIN=http://localhost:3000 \
		WALLET_JWT_SECRET=test-secret-for-e2e-testing-minimum-32-chars \
		go run ./cmd/server/... &
	cd $(WORKSPACE_DIR)/wallet-frontend && \
		VITE_WALLET_BACKEND_URL=http://localhost:8080 \
		npm run start -- --host &
	@echo "$(GREEN)Waiting for servers...$(NC)"
	@for i in $$(seq 1 60); do \
		if curl -sf $(BACKEND_URL)/status >/dev/null && curl -sf $(FRONTEND_URL) >/dev/null; then \
			break; fi; sleep 1; done
	@echo "$(GREEN)Running tests...$(NC)"
	-npx playwright test --forbid-only; result=$$?; \
		$(MAKE) teardown; exit $$result

# =============================================================================
# Cleanup
# =============================================================================

teardown: ## Stop servers
	@echo "$(YELLOW)Stopping servers...$(NC)"
	@pkill -f "go run.*go-wallet-backend" 2>/dev/null || true
	@pkill -f "vite" 2>/dev/null || true
	@pkill -f "node.*wallet-frontend" 2>/dev/null || true
	@docker-compose down 2>/dev/null || true
	@sleep 1
	@echo "$(GREEN)Stopped$(NC)"

clean: ## Remove test artifacts
	rm -rf test-results/ playwright-report/

clean-all: clean ## Remove all generated files
	rm -rf node_modules/ $(WORKSPACE_DIR)/

check-servers: ## Check if servers are reachable
	@curl -sf $(BACKEND_URL)/status >/dev/null && \
		echo "  $(GREEN)✓$(NC) Backend: $(BACKEND_URL)" || \
		(echo "  $(RED)✗$(NC) Backend: $(BACKEND_URL)"; exit 1)
	@curl -sf $(FRONTEND_URL) >/dev/null && \
		echo "  $(GREEN)✓$(NC) Frontend: $(FRONTEND_URL)" || \
		(echo "  $(RED)✗$(NC) Frontend: $(FRONTEND_URL)"; exit 1)

.DEFAULT_GOAL := help
