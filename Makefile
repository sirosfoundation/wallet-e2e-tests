# Wallet E2E Tests Makefile
#
# Primary Workflow:
#   make up      # Start fresh environment (soft-fido2 + Docker services)
#   make tests   # Run all tests (API + WebAuthn)
#   make down    # Stop everything
#
# The Makefile assumes the following workspace layout:
#   ../soft-fido2        - Virtual FIDO2 authenticator
#   ../wallet-frontend   - React frontend
#   ../go-wallet-backend - Go backend
#
# Override paths if needed:
#   make up SOFT_FIDO2_PATH=/custom/path FRONTEND_PATH=/custom/frontend

.PHONY: help install \
        up down logs status \
        tests test-api test-webauthn test-credential test-tenant test-registry \
        tests-ci test-api-ci test-webauthn-ci \
        start-soft-fido2 stop-soft-fido2 \
        clean clean-all

# =============================================================================
# Configuration - Override these via environment or command line
# =============================================================================

# Service URLs
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080
ADMIN_URL ?= http://localhost:8081
MOCK_ISSUER_URL ?= http://localhost:9000
MOCK_VERIFIER_URL ?= http://localhost:9001
MOCK_PDP_URL ?= http://localhost:9091
VCTM_REGISTRY_URL ?= http://localhost:8097
ADMIN_TOKEN ?= e2e-test-admin-token-for-testing-purposes-only

# Workspace paths - defaults assume sibling directories
SOFT_FIDO2_PATH ?= ../soft-fido2
FRONTEND_PATH ?= ../wallet-frontend
BACKEND_PATH ?= ../go-wallet-backend

# Docker compose file
TEST_COMPOSE_FILE := docker-compose.test.yml

# soft-fido2 runtime files
SOFT_FIDO2_PID ?= /tmp/soft-fido2.pid
SOFT_FIDO2_LOG ?= /tmp/soft-fido2.log

# Common environment for test execution
TEST_ENV := FRONTEND_URL=$(FRONTEND_URL) \
            BACKEND_URL=$(BACKEND_URL) \
            ADMIN_URL=$(ADMIN_URL) \
            ADMIN_TOKEN=$(ADMIN_TOKEN) \
            ISSUER_URL=$(MOCK_ISSUER_URL) \
            VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) \
            MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            TRUST_PDP_URL=$(MOCK_PDP_URL) \
            MOCK_PDP_URL=$(MOCK_PDP_URL) \
            VCTM_REGISTRY_URL=$(VCTM_REGISTRY_URL)

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

# =============================================================================
# Help
# =============================================================================

help: ## Show this help
	@echo "Wallet E2E Tests"
	@echo ""
	@echo "$(GREEN)Primary Workflow:$(NC)"
	@echo "  make up       # Start environment (soft-fido2 + Docker services)"
	@echo "  make tests    # Run all tests (API + WebAuthn)"
	@echo "  make down     # Stop everything"
	@echo ""
	@echo "$(GREEN)Focused Test Targets:$(NC)"
	@echo "  make test-api       # API tests only (headless)"
	@echo "  make test-webauthn  # WebAuthn UI tests (headed)"
	@echo "  make test-credential # Credential flow tests"
	@echo "  make test-tenant    # Tenant selector tests"
	@echo "  make test-registry  # VCTM registry tests"
	@echo ""
	@echo "$(GREEN)CI Targets (with Xvfb):$(NC)"
	@echo "  make tests-ci       # All tests with virtual display"
	@echo ""
	@echo "$(GREEN)Workspace Paths:$(NC)"
	@echo "  SOFT_FIDO2_PATH = $(SOFT_FIDO2_PATH)"
	@echo "  FRONTEND_PATH   = $(FRONTEND_PATH)"
	@echo "  BACKEND_PATH    = $(BACKEND_PATH)"
	@echo ""
	@echo "$(GREEN)Service URLs:$(NC)"
	@echo "  FRONTEND_URL     = $(FRONTEND_URL)"
	@echo "  BACKEND_URL      = $(BACKEND_URL)"
	@echo "  ADMIN_URL        = $(ADMIN_URL)"
	@echo "  VCTM_REGISTRY_URL= $(VCTM_REGISTRY_URL)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-18s$(NC) %s\n", $$1, $$2}'

# =============================================================================
# Installation
# =============================================================================

install: ## Install dependencies and Playwright browsers
	@echo "$(GREEN)Installing dependencies...$(NC)"
	npm install
	npx playwright install chromium
	@echo "$(GREEN)Ready! Run 'make up' to start the test environment.$(NC)"

# =============================================================================
# Environment Management
# =============================================================================

start-soft-fido2: ## Start soft-fido2 virtual authenticator
	@if [ -z "$(SOFT_FIDO2_PATH)" ] || [ ! -d "$(SOFT_FIDO2_PATH)" ]; then \
		echo "$(YELLOW)SOFT_FIDO2_PATH not set or not found, skipping virtual authenticator$(NC)"; \
	else \
		SOFT_FIDO2_PATH=$(SOFT_FIDO2_PATH) \
		SOFT_FIDO2_PID=$(SOFT_FIDO2_PID) \
		SOFT_FIDO2_LOG=$(SOFT_FIDO2_LOG) \
		./scripts/start-soft-fido2.sh; \
	fi

stop-soft-fido2: ## Stop soft-fido2 virtual authenticator
	@SOFT_FIDO2_PID=$(SOFT_FIDO2_PID) \
	SOFT_FIDO2_LOG=$(SOFT_FIDO2_LOG) \
	./scripts/stop-soft-fido2.sh

up: start-soft-fido2 ## Start test environment (soft-fido2 + Docker services)
	@echo "$(GREEN)Starting test environment...$(NC)"
	@# Copy Dockerfile to frontend context
	@cp -f dockerfiles/frontend.Dockerfile $(FRONTEND_PATH)/Dockerfile.e2e 2>/dev/null || true
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) build --no-cache
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) up -d
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@for i in $$(seq 1 120); do \
		if curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		   curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(MOCK_ISSUER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_PDP_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null 2>&1; then \
			echo "$(GREEN)All services healthy!$(NC)"; break; \
		fi; \
		echo "  Waiting... ($$i/120)"; sleep 2; \
	done
	@# Final health check with error reporting
	@curl -sf $(FRONTEND_URL) >/dev/null || (echo "$(RED)Frontend not ready$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || (echo "$(RED)Backend not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_ISSUER_URL)/health >/dev/null || (echo "$(RED)Mock issuer not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null || (echo "$(RED)Mock verifier not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_PDP_URL)/health >/dev/null || (echo "$(RED)Mock PDP not ready$(NC)"; exit 1)
	@curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null || (echo "$(RED)VCTM Registry not ready$(NC)"; exit 1)
	@# Register mock issuer and verifier
	@$(MAKE) -s register-mocks

register-mocks: ## Register mock issuer and verifier with backend
	@echo "$(GREEN)Registering mock services...$(NC)"
	@# Register mock issuer
	@curl -sf -X POST $(ADMIN_URL)/admin/tenants/default/issuers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"credential_issuer_identifier": "$(MOCK_ISSUER_URL)", "client_id": "wallet-e2e-client", "visible": true}' \
		>/dev/null 2>&1 || true
	@curl -sf $(ADMIN_URL)/admin/tenants/default/issuers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" | \
		grep -q "$(MOCK_ISSUER_URL)" && \
		echo "  $(GREEN)✓$(NC) Mock Issuer: $(MOCK_ISSUER_URL)" || \
		echo "  $(RED)✗$(NC) Mock Issuer registration failed"
	@# Register mock verifier
	@curl -sf -X POST $(ADMIN_URL)/admin/tenants/default/verifiers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"name": "E2E Mock Verifier", "url": "$(MOCK_VERIFIER_URL)"}' \
		>/dev/null 2>&1 || true
	@curl -sf $(ADMIN_URL)/admin/tenants/default/verifiers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" | \
		grep -q "$(MOCK_VERIFIER_URL)" && \
		echo "  $(GREEN)✓$(NC) Mock Verifier: $(MOCK_VERIFIER_URL)" || \
		echo "  $(RED)✗$(NC) Mock Verifier registration failed"

down: stop-soft-fido2 ## Stop test environment
	@echo "$(YELLOW)Stopping test environment...$(NC)"
	-@docker compose -f $(TEST_COMPOSE_FILE) down -v 2>/dev/null || true
	@echo "$(GREEN)Environment stopped$(NC)"

logs: ## View service logs
	docker compose -f $(TEST_COMPOSE_FILE) logs -f

status: ## Check service status
	@echo "$(GREEN)Service Status:$(NC)"
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
	@curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) VCTM Registry: $(VCTM_REGISTRY_URL)" || \
		echo "  $(RED)✗$(NC) VCTM Registry: $(VCTM_REGISTRY_URL)"
	@if [ -f "$(SOFT_FIDO2_PID)" ] && kill -0 $$(cat "$(SOFT_FIDO2_PID)") 2>/dev/null; then \
		echo "  $(GREEN)✓$(NC) soft-fido2: running (PID: $$(cat $(SOFT_FIDO2_PID)))"; \
	else \
		echo "  $(YELLOW)-$(NC) soft-fido2: not running"; \
	fi

# =============================================================================
# Test Execution
# =============================================================================

# Main test target - runs all tests
tests: test-api test-webauthn ## Run all tests (API + WebAuthn)

# API tests (headless, fast)
test-api: ## Run API tests (headless)
	@echo "$(GREEN)Running API tests...$(NC)"
	@curl -sf $(BACKEND_URL)/status >/dev/null || \
		(echo "$(RED)Backend not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test specs/api/ --reporter=list

# WebAuthn UI tests (headed, requires display)
test-webauthn: ## Run WebAuthn UI tests (headed, requires display)
	@echo "$(GREEN)Running WebAuthn UI tests...$(NC)"
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# Individual test targets for focused testing
test-credential: ## Run credential flow tests (issuance & verification)
	@echo "$(GREEN)Running credential flow tests...$(NC)"
	$(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts \
		specs/real-webauthn/credential-flow.spec.ts --reporter=list

test-tenant: ## Run tenant selector tests
	@echo "$(GREEN)Running tenant selector tests...$(NC)"
	$(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts \
		specs/real-webauthn/tenant-selector.spec.ts --reporter=list

test-registry: ## Run VCTM registry tests
	@echo "$(GREEN)Running VCTM registry tests...$(NC)"
	@curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null || \
		(echo "$(RED)Registry not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test specs/api/registry.spec.ts --reporter=list

# =============================================================================
# CI Targets (with Xvfb virtual display)
# =============================================================================

tests-ci: test-api-ci test-webauthn-ci ## Run all tests with Xvfb (CI mode)

test-api-ci: ## Run API tests in CI (headless)
	@echo "$(GREEN)Running API tests (CI)...$(NC)"
	$(TEST_ENV) npx playwright test specs/api/ --reporter=list

test-webauthn-ci: ## Run WebAuthn tests with Xvfb (CI mode)
	@echo "$(GREEN)Running WebAuthn UI tests with Xvfb...$(NC)"
	@command -v xvfb-run >/dev/null 2>&1 || \
		(echo "$(RED)xvfb-run not found. Install: apt-get install xvfb$(NC)"; exit 1)
	xvfb-run -a --server-args="-screen 0 1920x1080x24" \
		env $(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# Full CI cycle
ci: up tests-ci down ## Full CI: start → test → cleanup

# =============================================================================
# Debug Targets
# =============================================================================

test-headed: ## Run all tests with visible browser
	$(TEST_ENV) npx playwright test --headed

test-debug: ## Run tests with debugger
	$(TEST_ENV) npx playwright test --debug

test-ui: ## Open Playwright UI
	$(TEST_ENV) npx playwright test --ui

# =============================================================================
# Cleanup
# =============================================================================

clean: ## Remove test artifacts
	rm -rf test-results/ playwright-report/ playwright-report-real-webauthn/

clean-all: clean ## Remove all generated files
	rm -rf node_modules/

# =============================================================================
# Legacy Aliases (for backward compatibility)
# =============================================================================

run: tests ## Alias for 'tests'
test: tests ## Alias for 'tests'
test-real-webauthn: test-webauthn ## Alias for 'test-webauthn'
test-real-webauthn-ci: test-webauthn-ci ## Alias for 'test-webauthn-ci'
test-credential-flow: test-credential ## Alias for 'test-credential'
ci-docker: ci ## Alias for 'ci'
ci-real-webauthn: ci ## Alias for 'ci'

.DEFAULT_GOAL := help
