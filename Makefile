# Wallet E2E Tests Makefile
#
# Usage:
#   make up         # Start test environment (Docker)
#   make run        # Run all E2E tests
#   make down       # Stop test environment
#   make ci-docker  # Full CI: up, run, down

.PHONY: help install test test-headed test-debug test-ui \
        test-prf test-registration test-login test-trust test-verifier \
        up down logs run ci-docker status \
        clean clean-all check-servers

# Configuration
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080
ADMIN_URL ?= http://localhost:8081
MOCK_ISSUER_URL ?= http://localhost:9000
MOCK_VERIFIER_URL ?= http://localhost:9001
MOCK_PDP_URL ?= http://localhost:9091
TEST_COMPOSE_FILE := docker-compose.test.yml
ADMIN_TOKEN ?= e2e-test-admin-token-for-testing-purposes-only

# Colors
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

help: ## Show this help
	@echo "Wallet E2E Tests"
	@echo ""
	@echo "Quick Start:"
	@echo "  make up       # Start all services"
	@echo "  make run      # Run tests"
	@echo "  make down     # Stop services"
	@echo ""
	@echo "Configuration:"
	@echo "  FRONTEND_URL    = $(FRONTEND_URL)"
	@echo "  BACKEND_URL     = $(BACKEND_URL)"
	@echo "  ADMIN_URL       = $(ADMIN_URL)"
	@echo "  MOCK_ISSUER_URL = $(MOCK_ISSUER_URL)"
	@echo "  MOCK_PDP_URL    = $(MOCK_PDP_URL)"
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
# Docker Compose Test Environment
# =============================================================================

up: ## Start test environment (frontend + backend + mocks)
	@echo "$(GREEN)Starting test environment...$(NC)"
	@# Copy our Dockerfile to the frontend context before build
	@cp -f dockerfiles/frontend.Dockerfile $(FRONTEND_PATH)/Dockerfile.e2e 2>/dev/null || true
	docker compose -f $(TEST_COMPOSE_FILE) up -d --build
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@for i in $$(seq 1 120); do \
		if curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		   curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(MOCK_ISSUER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_PDP_URL)/health >/dev/null 2>&1; then \
			echo "$(GREEN)All services are healthy!$(NC)"; break; \
		fi; \
		echo "  Waiting... ($$i/120)"; sleep 2; \
	done
	@curl -sf $(FRONTEND_URL) >/dev/null || (echo "$(RED)Frontend not ready$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || (echo "$(RED)Backend not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_ISSUER_URL)/health >/dev/null || (echo "$(RED)Mock issuer not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null || (echo "$(RED)Mock verifier not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_PDP_URL)/health >/dev/null || (echo "$(RED)Mock PDP not ready$(NC)"; exit 1)

down: ## Stop test environment
	@echo "$(YELLOW)Stopping test environment...$(NC)"
	-@docker compose -f $(TEST_COMPOSE_FILE) down -v 2>/dev/null || true
	@echo "$(GREEN)Services stopped$(NC)"

logs: ## View logs from test services
	docker compose -f $(TEST_COMPOSE_FILE) logs -f

status: ## Check status of test services
	@echo "Service Status:"
	@curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Frontend: $(FRONTEND_URL)" || \
		echo "  $(RED)✗$(NC) Frontend: $(FRONTEND_URL)"
	@curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Backend: $(BACKEND_URL)" || \
		echo "  $(RED)✗$(NC) Backend: $(BACKEND_URL)"
	@curl -sf $(MOCK_ISSUER_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Mock Issuer: $(MOCK_ISSUER_URL)" || \
		echo "  $(RED)✗$(NC) Mock Issuer: $(MOCK_ISSUER_URL)"
	@curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Mock Verifier: $(MOCK_VERIFIER_URL)" || \
		echo "  $(RED)✗$(NC) Mock Verifier: $(MOCK_VERIFIER_URL)"
	@curl -sf $(MOCK_PDP_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Mock PDP: $(MOCK_PDP_URL)" || \
		echo "  $(RED)✗$(NC) Mock PDP: $(MOCK_PDP_URL)"

# =============================================================================
# Test Execution
# =============================================================================

run: ## Run all E2E tests (requires 'make up' first)
	@echo "$(GREEN)Running E2E tests...$(NC)"
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up' first.$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || \
		(echo "$(RED)Backend not running. Run 'make up' first.$(NC)"; exit 1)
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test

test: run ## Alias for 'run'

test-headed: ## Run tests with visible browser
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test --headed

test-debug: ## Run tests with debugger
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test --debug

test-ui: ## Open Playwright UI
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test --ui

test-prf: ## Run PRF tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		npx playwright test --grep "@prf"

test-registration: ## Run registration tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		npx playwright test --grep "@registration"

test-login: ## Run login tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		npx playwright test --grep "@login"

test-trust: ## Run trust API tests only (issuer and verifier)
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test --grep "@trust"

test-verifier: ## Run verifier trust tests only
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test specs/api/verifier-trust.spec.ts

test-multi-tenancy: ## Run multi-tenancy tests (requires Admin API)
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test specs/multi-tenancy/

test-critical: ## Run critical path tests (register→login flow) - catches integration bugs
	@echo "$(GREEN)Running critical path tests...$(NC)"
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test --grep "@critical"

test-urls: ## Run tenant-aware URL routing tests
	@echo "$(GREEN)Running tenant-aware URL tests...$(NC)"
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test specs/multi-tenancy/tenant-aware-urls.spec.ts

test-discover: ## Run discover-and-trust API tests
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test specs/api/discover-and-trust.spec.ts

# =============================================================================
# Real WebAuthn Tests (No CDP Mocking)
# =============================================================================

test-real-webauthn: ## Run real WebAuthn integration tests (requires X11 or Xvfb)
	@echo "$(GREEN)Running real WebAuthn integration tests...$(NC)"
	@echo "  Note: These tests use headed browser - requires display"
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up' first.$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || \
		(echo "$(RED)Backend not running. Run 'make up' first.$(NC)"; exit 1)
	FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test --config=playwright.real-webauthn.config.ts specs/real-webauthn/integration.spec.ts

test-real-webauthn-basic: ## Run basic real WebAuthn tests (no services required)
	@echo "$(GREEN)Running basic real WebAuthn tests...$(NC)"
	npx playwright test --config=playwright.real-webauthn.config.ts specs/real-webauthn/multi-tenant-login.spec.ts

# Run real WebAuthn tests with Xvfb (for headless CI)
test-real-webauthn-ci: ## Run real WebAuthn tests with virtual display (CI mode)
	@echo "$(GREEN)Running real WebAuthn tests with Xvfb...$(NC)"
	@command -v xvfb-run >/dev/null 2>&1 || \
		(echo "$(RED)xvfb-run not found. Install xvfb: apt-get install xvfb$(NC)"; exit 1)
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up' first.$(NC)"; exit 1)
	xvfb-run -a --server-args="-screen 0 1920x1080x24" \
		env FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test --config=playwright.real-webauthn.config.ts specs/real-webauthn/integration.spec.ts

ci-real-webauthn: up ## Full CI: start services, run real WebAuthn tests with Xvfb, cleanup
	@echo "$(GREEN)Running real WebAuthn CI tests...$(NC)"
	-xvfb-run -a --server-args="-screen 0 1920x1080x24" \
		env FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		ADMIN_URL=$(ADMIN_URL) \
		npx playwright test --config=playwright.real-webauthn.config.ts specs/real-webauthn/integration.spec.ts; \
	result=$$?; \
	$(MAKE) down; \
	exit $$result

ci-docker: up ## Full CI: start services, run tests, cleanup
	@echo "$(GREEN)Running tests...$(NC)"
	-FRONTEND_URL=$(FRONTEND_URL) BACKEND_URL=$(BACKEND_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) \
		MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
		TRUST_PDP_URL=$(MOCK_PDP_URL) MOCK_PDP_URL=$(MOCK_PDP_URL) \
		npx playwright test; \
	result=$$?; \
	$(MAKE) down; \
	exit $$result

# =============================================================================
# Cleanup
# =============================================================================

clean: ## Remove test artifacts
	rm -rf test-results/ playwright-report/

clean-all: clean ## Remove all generated files
	rm -rf node_modules/

.DEFAULT_GOAL := help