# Wallet E2E Tests Makefile
#
# Environment Variables:
#   FRONTEND_URL    - URL of wallet-frontend (default: http://localhost:3000)
#   BACKEND_URL     - URL of go-wallet-backend (default: http://localhost:8080)
#   FRONTEND_PATH   - Path to wallet-frontend repo (for local setup)
#   BACKEND_PATH    - Path to go-wallet-backend repo (for local setup)
#   FRONTEND_VERSION - Docker image version for frontend (default: latest)
#   BACKEND_VERSION  - Docker image version for backend (default: latest)
#
# Examples:
#   make test                                    # Run against localhost
#   make test FRONTEND_URL=http://staging:3000   # Run against staging
#   make setup-local                             # Start local servers
#   make test-matrix                             # Run version matrix tests

.PHONY: help install setup setup-local setup-docker teardown teardown-docker \
        test test-headed test-debug test-ui test-trace \
        test-prf test-registration test-login test-api test-full-flow \
        test-matrix clean clean-all check-servers report

# Default values
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080
FRONTEND_PATH ?= ../wallet-frontend
BACKEND_PATH ?= ../go-wallet-backend
FRONTEND_VERSION ?= latest
BACKEND_VERSION ?= latest

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

help: ## Show this help
	@echo "Wallet E2E Tests"
	@echo ""
	@echo "Environment Variables:"
	@echo "  FRONTEND_URL     = $(FRONTEND_URL)"
	@echo "  BACKEND_URL      = $(BACKEND_URL)"
	@echo "  FRONTEND_PATH    = $(FRONTEND_PATH)"
	@echo "  BACKEND_PATH     = $(BACKEND_PATH)"
	@echo "  FRONTEND_VERSION = $(FRONTEND_VERSION)"
	@echo "  BACKEND_VERSION  = $(BACKEND_VERSION)"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-18s$(NC) %s\n", $$1, $$2}'

# =============================================================================
# Setup & Installation
# =============================================================================

install: ## Install npm dependencies and Playwright browsers
	@echo "$(GREEN)Installing dependencies...$(NC)"
	@npm install
	@echo "$(GREEN)Installing Playwright browsers...$(NC)"
	@npx playwright install chromium
	@echo "$(GREEN)Setup complete!$(NC)"

setup: install check-servers ## Install dependencies and verify servers are running
	@echo "$(GREEN)Ready to run tests against:$(NC)"
	@echo "  Frontend: $(FRONTEND_URL)"
	@echo "  Backend:  $(BACKEND_URL)"

setup-local: install ## Start local servers from source repos
	@echo "$(GREEN)Starting local servers...$(NC)"
	@if [ ! -d "$(FRONTEND_PATH)" ]; then \
		echo "$(RED)Error: Frontend path not found: $(FRONTEND_PATH)$(NC)"; \
		exit 1; \
	fi
	@if [ ! -d "$(BACKEND_PATH)" ]; then \
		echo "$(RED)Error: Backend path not found: $(BACKEND_PATH)$(NC)"; \
		exit 1; \
	fi
	@./scripts/setup-local.sh --frontend-path "$(FRONTEND_PATH)" --backend-path "$(BACKEND_PATH)"

setup-docker: install ## Start servers using Docker Compose
	@echo "$(GREEN)Starting Docker containers...$(NC)"
	@echo "  Frontend version: $(FRONTEND_VERSION)"
	@echo "  Backend version:  $(BACKEND_VERSION)"
	@FRONTEND_VERSION=$(FRONTEND_VERSION) BACKEND_VERSION=$(BACKEND_VERSION) \
		docker-compose up -d --wait
	@echo "$(GREEN)Containers started!$(NC)"
	@echo "  Frontend: http://localhost:3000"
	@echo "  Backend:  http://localhost:8080"

setup-docker-local: install ## Build and start servers from local source using Docker
	@echo "$(GREEN)Building and starting local Docker containers...$(NC)"
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker-compose -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait
	@echo "$(GREEN)Containers started!$(NC)"

# =============================================================================
# Teardown & Cleanup
# =============================================================================

teardown: ## Stop local servers started by setup-local
	@echo "$(YELLOW)Stopping local servers...$(NC)"
	@pkill -f "go run.*go-wallet-backend" 2>/dev/null || true
	@pkill -f "vite" 2>/dev/null || true
	@echo "$(GREEN)Servers stopped$(NC)"

teardown-docker: ## Stop Docker containers
	@echo "$(YELLOW)Stopping Docker containers...$(NC)"
	@docker-compose down --remove-orphans
	@echo "$(GREEN)Containers stopped$(NC)"

clean: ## Remove test results and reports
	@echo "$(YELLOW)Cleaning test artifacts...$(NC)"
	@rm -rf test-results/
	@rm -rf playwright-report/
	@echo "$(GREEN)Clean complete$(NC)"

clean-all: clean ## Remove all generated files including node_modules
	@echo "$(YELLOW)Cleaning all generated files...$(NC)"
	@rm -rf node_modules/
	@rm -rf dist/
	@echo "$(GREEN)Full clean complete$(NC)"

# =============================================================================
# Server Checks
# =============================================================================

check-servers: ## Check if frontend and backend are reachable
	@echo "$(GREEN)Checking servers...$(NC)"
	@if curl -sf "$(BACKEND_URL)/status" > /dev/null 2>&1; then \
		echo "  $(GREEN)✓$(NC) Backend:  $(BACKEND_URL)"; \
	else \
		echo "  $(RED)✗$(NC) Backend:  $(BACKEND_URL) - $(RED)NOT REACHABLE$(NC)"; \
		exit 1; \
	fi
	@if curl -sf "$(FRONTEND_URL)" > /dev/null 2>&1; then \
		echo "  $(GREEN)✓$(NC) Frontend: $(FRONTEND_URL)"; \
	else \
		echo "  $(RED)✗$(NC) Frontend: $(FRONTEND_URL) - $(RED)NOT REACHABLE$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)All servers ready!$(NC)"

wait-for-servers: ## Wait for servers to become available (with timeout)
	@echo "$(GREEN)Waiting for servers...$(NC)"
	@for i in $$(seq 1 60); do \
		if curl -sf "$(BACKEND_URL)/status" > /dev/null 2>&1 && \
		   curl -sf "$(FRONTEND_URL)" > /dev/null 2>&1; then \
			echo "$(GREEN)Servers ready!$(NC)"; \
			exit 0; \
		fi; \
		echo "  Waiting... ($$i/60)"; \
		sleep 2; \
	done; \
	echo "$(RED)Timeout waiting for servers$(NC)"; \
	exit 1

# =============================================================================
# Test Execution
# =============================================================================

test: ## Run all E2E tests
	@echo "$(GREEN)Running E2E tests...$(NC)"
	@echo "  Frontend: $(FRONTEND_URL)"
	@echo "  Backend:  $(BACKEND_URL)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test

test-headed: ## Run tests with visible browser
	@echo "$(GREEN)Running E2E tests (headed)...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --headed

test-debug: ## Run tests with Playwright debugger
	@echo "$(GREEN)Running E2E tests (debug mode)...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --debug

test-ui: ## Open Playwright UI for interactive testing
	@echo "$(GREEN)Opening Playwright UI...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --ui

test-trace: ## Run tests with trace recording
	@echo "$(GREEN)Running E2E tests with trace...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --trace on

# =============================================================================
# Test Suites (by tag)
# =============================================================================

test-prf: ## Run PRF mock tests only
	@echo "$(GREEN)Running PRF tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@prf"

test-registration: ## Run registration tests only
	@echo "$(GREEN)Running registration tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@registration"

test-login: ## Run login tests only
	@echo "$(GREEN)Running login tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@login"

test-api: ## Run API compatibility tests only
	@echo "$(GREEN)Running API tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@api"

test-full-flow: ## Run full flow tests only
	@echo "$(GREEN)Running full flow tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@full-flow"

test-diagnostics: ## Run diagnostic tests only
	@echo "$(GREEN)Running diagnostic tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test --grep "@diagnostics"

# =============================================================================
# Test by File/Directory
# =============================================================================

test-spec: ## Run a specific spec file (usage: make test-spec SPEC=specs/prf/prf-mock.spec.ts)
	@if [ -z "$(SPEC)" ]; then \
		echo "$(RED)Error: SPEC not specified$(NC)"; \
		echo "Usage: make test-spec SPEC=specs/prf/prf-mock.spec.ts"; \
		exit 1; \
	fi
	@echo "$(GREEN)Running spec: $(SPEC)$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) \
		npx playwright test "$(SPEC)"

# =============================================================================
# Version Matrix Testing
# =============================================================================

test-matrix: ## Run tests against multiple version combinations
	@echo "$(GREEN)Running version matrix tests...$(NC)"
	@./scripts/run-matrix.sh \
		--frontend-versions "$(FRONTEND_VERSIONS)" \
		--backend-versions "$(BACKEND_VERSIONS)"

test-matrix-latest: ## Quick matrix test with just 'latest' versions
	@echo "$(GREEN)Running quick matrix test (latest only)...$(NC)"
	@FRONTEND_VERSIONS="latest" BACKEND_VERSIONS="latest" \
		./scripts/run-matrix.sh

# =============================================================================
# Reports
# =============================================================================

report: ## Open the HTML test report
	@echo "$(GREEN)Opening test report...$(NC)"
	@npx playwright show-report

report-serve: ## Serve the HTML report on a local port
	@echo "$(GREEN)Serving test report on http://localhost:9323$(NC)"
	@npx playwright show-report --port 9323

# =============================================================================
# CI/CD Helpers
# =============================================================================

ci-test: install ## Run tests in CI mode (no retries on first run, strict)
	@echo "$(GREEN)Running CI tests...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) CI=true \
		npx playwright test --forbid-only

ci-test-with-docker: setup-docker ci-test teardown-docker ## Full CI run with Docker setup/teardown

# =============================================================================
# Development Helpers
# =============================================================================

list-tests: ## List all available test files
	@echo "$(GREEN)Available test specs:$(NC)"
	@find specs -name "*.spec.ts" | sort | while read f; do \
		echo "  $$f"; \
	done

list-tags: ## List all test tags used
	@echo "$(GREEN)Available test tags:$(NC)"
	@grep -h "@[a-z-]*" specs/**/*.spec.ts 2>/dev/null | \
		grep -oE "@[a-z-]+" | sort -u | while read t; do \
		echo "  $$t"; \
	done

codegen: ## Open Playwright codegen to record tests
	@echo "$(GREEN)Opening Playwright codegen...$(NC)"
	@FRONTEND_URL=$(FRONTEND_URL) \
		npx playwright codegen "$(FRONTEND_URL)"

.DEFAULT_GOAL := help
