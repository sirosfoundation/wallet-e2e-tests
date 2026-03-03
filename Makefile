# Wallet E2E Tests Makefile
#
# Primary Workflow (CDP - headless, CI-compatible):
#   make up      # Start Docker services only (no soft-fido2 needed)
#   make test    # Run all tests using CDP virtual authenticator
#   make down    # Stop Docker services
#
# Soft-FIDO2 Workflow (browser-based, requires display):
#   make up-soft-fido2    # Start soft-fido2 + Docker services
#   make test-soft-fido2  # Run tests with soft-fido2 authenticator
#   make down-soft-fido2  # Stop everything including soft-fido2
#
# Transport Modes:
#   make test-http          # Run tests forcing HTTP transport
#   make test-ws            # Run tests forcing WebSocket transport
#   make test-all-transports # Run test suite for each transport
#
# The Makefile assumes the following workspace layout:
#   ../wallet-frontend   - React frontend
#   ../go-wallet-backend - Go backend
#   ../soft-fido2        - Virtual FIDO2 authenticator (optional, for browser tests)
#
# Override paths if needed:
#   make up FRONTEND_PATH=/custom/frontend BACKEND_PATH=/custom/backend

.PHONY: help install \
        up down logs status \
        tests test test-api test-webauthn test-credential test-tenant test-registry test-go-trust \
        test-http test-ws test-all-transports check-ws-available \
        tests-ci test-api-ci test-webauthn-ci \
        start-soft-fido2 stop-soft-fido2 up-soft-fido2 down-soft-fido2 test-soft-fido2 \
        up-vc down-vc test-vc test-all-services \
        up-go-trust down-go-trust \
        clean clean-all

# =============================================================================
# Configuration - Override these via environment or command line
# =============================================================================

# Service URLs
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080
ENGINE_URL ?= http://localhost:8082
ADMIN_URL ?= http://localhost:8081
MOCK_ISSUER_URL ?= http://localhost:9000
MOCK_VERIFIER_URL ?= http://localhost:9001
MOCK_PDP_URL ?= http://localhost:9091
VCTM_REGISTRY_URL ?= http://localhost:8097
ADMIN_TOKEN ?= e2e-test-admin-token-for-testing-purposes-only

# Transport mode: auto | http | websocket
TRANSPORT_MODE ?= auto

# Workspace paths - defaults assume sibling directories
SOFT_FIDO2_PATH ?= ../soft-fido2
FRONTEND_PATH ?= ../wallet-frontend
BACKEND_PATH ?= ../go-wallet-backend

# Docker compose file
TEST_COMPOSE_FILE := docker-compose.test.yml
TS_BACKEND_COMPOSE := docker-compose.ts-backend.yml
VC_SERVICES_COMPOSE := docker-compose.vc-services.yml

# TypeScript backend path (for testing without mode support)
TS_BACKEND_PATH ?= ../wallet-backend-server

# soft-fido2 runtime files
SOFT_FIDO2_PID ?= /tmp/soft-fido2.pid
SOFT_FIDO2_LOG ?= /tmp/soft-fido2.log

# Common environment for test execution
TEST_ENV := FRONTEND_URL=$(FRONTEND_URL) \
            BACKEND_URL=$(BACKEND_URL) \
            ENGINE_URL=$(ENGINE_URL) \
            ADMIN_URL=$(ADMIN_URL) \
            ADMIN_TOKEN=$(ADMIN_TOKEN) \
            ISSUER_URL=$(MOCK_ISSUER_URL) \
            VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) \
            MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            TRUST_PDP_URL=$(MOCK_PDP_URL) \
            MOCK_PDP_URL=$(MOCK_PDP_URL) \
            VCTM_REGISTRY_URL=$(VCTM_REGISTRY_URL) \
            TRANSPORT_MODE=$(TRANSPORT_MODE)

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
	@echo "$(GREEN)Primary Workflow (CDP - headless, CI-compatible):$(NC)"
	@echo "  make up       # Start Docker services only"
	@echo "  make test     # Run all tests with CDP virtual authenticator"
	@echo "  make down     # Stop Docker services"
	@echo ""
	@echo "$(GREEN)Soft-FIDO2 Workflow (browser-based, requires display):$(NC)"
	@echo "  make up-soft-fido2    # Start soft-fido2 + Docker services"
	@echo "  make test-soft-fido2  # Run full browser tests with soft-fido2"
	@echo "  make down-soft-fido2  # Stop everything including soft-fido2"
	@echo ""
	@echo "$(GREEN)VC Services (Production-grade issuer/verifier):$(NC)"
	@echo "  make up-vc            # Start with VC services (issuer/verifier/mockas)"
	@echo "  make test-vc          # Run tests using VC services"
	@echo "  make down-vc          # Stop VC services"
	@echo ""
	@echo "$(GREEN)Transport Mode Testing:$(NC)"
	@echo "  make test-http           # Force HTTP transport"
	@echo "  make test-ws             # Force WebSocket transport"
	@echo "  make test-all-transports # Run tests for each available transport"
	@echo ""
	@echo "$(GREEN)Focused Test Targets:$(NC)"
	@echo "  make test-api        # API tests only (headless)"
	@echo "  make test-credential # Credential flow tests (CDP)"
	@echo "  make test-tenant     # Tenant selector tests (CDP)"
	@echo "  make test-registry   # VCTM registry tests"
	@echo "  make test-trust      # Trust integration tests (CDP)"
	@echo "  make test-go-trust   # Go-Trust PDP tests (whitelist, allow, deny)"
	@echo ""
	@echo "$(GREEN)Go-Trust Services:$(NC)"
	@echo "  make up-go-trust     # Start with go-trust PDP services"
	@echo "  make test-go-trust   # Run go-trust API tests"
	@echo "  make down-go-trust   # Stop go-trust environment"
	@echo ""
	@echo "$(GREEN)Configuration:$(NC)"
	@echo "  TRANSPORT_MODE  = $(TRANSPORT_MODE) (auto|http|websocket)"
	@echo "  FRONTEND_PATH   = $(FRONTEND_PATH)"
	@echo "  BACKEND_PATH    = $(BACKEND_PATH)"
	@echo "  SOFT_FIDO2_PATH = $(SOFT_FIDO2_PATH) (for browser tests)"
	@echo ""
	@echo "$(GREEN)Service URLs:$(NC)"
	@echo "  FRONTEND_URL     = $(FRONTEND_URL)"
	@echo "  BACKEND_URL      = $(BACKEND_URL)"
	@echo "  ENGINE_URL       = $(ENGINE_URL)"
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

up: ## Start Docker services for CDP tests (headless, no soft-fido2 needed)
	@echo "$(GREEN)Starting test environment (Docker services only)...$(NC)"
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
		   curl -sf $(ENGINE_URL)/status >/dev/null 2>&1 && \
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
	@curl -sf $(ENGINE_URL)/status >/dev/null || (echo "$(RED)Engine not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_ISSUER_URL)/health >/dev/null || (echo "$(RED)Mock issuer not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null || (echo "$(RED)Mock verifier not ready$(NC)"; exit 1)
	@curl -sf $(MOCK_PDP_URL)/health >/dev/null || (echo "$(RED)Mock PDP not ready$(NC)"; exit 1)
	@curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null || (echo "$(RED)VCTM Registry not ready$(NC)"; exit 1)
	@# Register mock issuer and verifier
	@$(MAKE) -s register-mocks
	@echo ""
	@echo "$(GREEN)Ready! Run 'make test' to execute CDP tests.$(NC)"

up-soft-fido2: start-soft-fido2 up ## Start soft-fido2 + Docker services (for browser tests)
	@echo ""
	@echo "$(GREEN)Ready! Run 'make test-soft-fido2' to execute browser tests.$(NC)"

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

# =============================================================================
# Backend Selection (for testing with different backends)
# =============================================================================

up-ts-backend: start-soft-fido2 ## Start with TypeScript wallet-backend-server (HTTP only)
	@echo "$(GREEN)Starting test environment with TypeScript backend...$(NC)"
	@echo "$(YELLOW)Note: WebSocket tests will be skipped with this backend$(NC)"
	@cp -f dockerfiles/frontend.Dockerfile $(FRONTEND_PATH)/Dockerfile.e2e 2>/dev/null || true
	@FRONTEND_PATH=$(FRONTEND_PATH) TS_BACKEND_PATH=$(TS_BACKEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) -f $(TS_BACKEND_COMPOSE) build --no-cache
	@FRONTEND_PATH=$(FRONTEND_PATH) TS_BACKEND_PATH=$(TS_BACKEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) -f $(TS_BACKEND_COMPOSE) up -d
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@for i in $$(seq 1 120); do \
		if curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		   curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(MOCK_ISSUER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_PDP_URL)/health >/dev/null 2>&1; then \
			echo "$(GREEN)All services healthy!$(NC)"; break; \
		fi; \
		echo "  Waiting... ($$i/120)"; sleep 2; \
	done
	@curl -sf $(FRONTEND_URL) >/dev/null || (echo "$(RED)Frontend not ready$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || (echo "$(RED)Backend not ready$(NC)"; exit 1)
	@$(MAKE) -s register-mocks
	@echo ""
	@echo "$(YELLOW)Using TypeScript backend - WebSocket transport not available$(NC)"
	@echo "$(YELLOW)Run tests with: make test-http$(NC)"

down-ts-backend: stop-soft-fido2 ## Stop TypeScript backend environment
	@echo "$(YELLOW)Stopping TypeScript backend environment...$(NC)"
	-@docker compose -f $(TEST_COMPOSE_FILE) -f $(TS_BACKEND_COMPOSE) down -v 2>/dev/null || true
	@echo "$(GREEN)Environment stopped$(NC)"

# =============================================================================
# VC Services (Production-grade issuer/verifier)
# =============================================================================
# Uses SUNET VC project's issuer, verifier, and mockas containers
# instead of the simple mock services for more comprehensive testing.

# VC Service URLs (override ports 9000/9001 with production VC services)
VC_ISSUER_URL ?= http://localhost:9000
VC_VERIFIER_URL ?= http://localhost:9001
VC_MOCKAS_URL ?= http://localhost:9002

up-vc: start-soft-fido2 ## Start with VC services (production issuer/verifier)
	@echo "$(GREEN)Starting test environment with VC services...$(NC)"
	@# Ensure PKI exists
	@if [ ! -f "fixtures/vc-pki/signing_ec_private.pem" ]; then \
		echo "$(GREEN)Generating PKI certificates...$(NC)"; \
		./fixtures/create-pki.sh; \
	fi
	@# Copy Dockerfile to frontend context
	@cp -f dockerfiles/frontend.Dockerfile $(FRONTEND_PATH)/Dockerfile.e2e 2>/dev/null || true
	@# Build and start base services (without mock issuer/verifier)
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) build --no-cache
	@# Create network first if not exists
	-@docker network create e2e-test-network 2>/dev/null || true
	@# Start VC services
	@docker compose -f $(VC_SERVICES_COMPOSE) up -d
	@# Start base test services (wallet, pdp, registry) - use --no-deps to avoid starting mock-issuer/verifier
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) up -d --no-deps wallet-frontend wallet-backend mock-trust-pdp vctm-registry
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@for i in $$(seq 1 180); do \
		if curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		   curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(ENGINE_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(VC_ISSUER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(VC_VERIFIER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_PDP_URL)/health >/dev/null 2>&1; then \
			echo "$(GREEN)All services healthy!$(NC)"; break; \
		fi; \
		echo "  Waiting... ($$i/180)"; sleep 2; \
	done
	@curl -sf $(FRONTEND_URL) >/dev/null || (echo "$(RED)Frontend not ready$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || (echo "$(RED)Backend not ready$(NC)"; exit 1)
	@curl -sf $(VC_ISSUER_URL)/health >/dev/null || (echo "$(RED)VC Issuer not ready$(NC)"; exit 1)
	@curl -sf $(VC_VERIFIER_URL)/health >/dev/null || (echo "$(RED)VC Verifier not ready$(NC)"; exit 1)
	@# Register VC services
	@$(MAKE) -s register-vc-services
	@echo ""
	@echo "$(GREEN)VC Services environment ready$(NC)"
	@echo "  Issuer:   $(VC_ISSUER_URL)"
	@echo "  Verifier: $(VC_VERIFIER_URL)"
	@echo "  MockAS:   $(VC_MOCKAS_URL)"

register-vc-services: ## Register VC issuer and verifier with backend
	@echo "$(GREEN)Registering VC services...$(NC)"
	@curl -sf -X POST $(ADMIN_URL)/admin/tenants/default/issuers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"credential_issuer_identifier": "$(VC_ISSUER_URL)", "client_id": "e2e-test-client", "visible": true}' \
		>/dev/null 2>&1 || true
	@curl -sf $(ADMIN_URL)/admin/tenants/default/issuers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" | \
		grep -q "$(VC_ISSUER_URL)" && \
		echo "  $(GREEN)✓$(NC) VC Issuer: $(VC_ISSUER_URL)" || \
		echo "  $(RED)✗$(NC) VC Issuer registration failed"
	@curl -sf -X POST $(ADMIN_URL)/admin/tenants/default/verifiers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"name": "E2E VC Verifier", "url": "$(VC_VERIFIER_URL)"}' \
		>/dev/null 2>&1 || true
	@curl -sf $(ADMIN_URL)/admin/tenants/default/verifiers \
		-H "Authorization: Bearer $(ADMIN_TOKEN)" | \
		grep -q "$(VC_VERIFIER_URL)" && \
		echo "  $(GREEN)✓$(NC) VC Verifier: $(VC_VERIFIER_URL)" || \
		echo "  $(RED)✗$(NC) VC Verifier registration failed"

down-vc: stop-soft-fido2 ## Stop VC services environment
	@echo "$(YELLOW)Stopping VC services environment...$(NC)"
	-@docker compose -f $(VC_SERVICES_COMPOSE) down -v 2>/dev/null || true
	-@docker compose -f $(TEST_COMPOSE_FILE) down -v 2>/dev/null || true
	@echo "$(GREEN)Environment stopped$(NC)"

# =============================================================================
# Go-Trust Services (AuthZEN PDP integration)
# =============================================================================
# Uses real go-trust PDP instead of mock, with different registry configurations:
#   - go-trust-allow (port 9091): AlwaysTrusted registry
#   - go-trust-deny (port 9092): NeverTrusted registry
#   - go-trust-whitelist (port 9093): Whitelist registry

GO_TRUST_PATH ?= ../go-trust
GO_TRUST_COMPOSE := docker-compose.go-trust.yml
GO_TRUST_ALLOW_URL ?= http://localhost:9094
GO_TRUST_DENY_URL ?= http://localhost:9092
GO_TRUST_WHITELIST_URL ?= http://localhost:9093

up-go-trust: ## Start with go-trust PDP services
	@echo "$(GREEN)Starting test environment with go-trust...$(NC)"
	@# Copy Dockerfile to frontend context
	@cp -f dockerfiles/frontend.Dockerfile $(FRONTEND_PATH)/Dockerfile.e2e 2>/dev/null || true
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) GO_TRUST_PATH=$(GO_TRUST_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) -f $(GO_TRUST_COMPOSE) build --no-cache
	@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) GO_TRUST_PATH=$(GO_TRUST_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) -f $(GO_TRUST_COMPOSE) up -d
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@for i in $$(seq 1 120); do \
		if curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		   curl -sf $(BACKEND_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(ENGINE_URL)/status >/dev/null 2>&1 && \
		   curl -sf $(MOCK_ISSUER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(MOCK_VERIFIER_URL)/health >/dev/null 2>&1 && \
		   curl -sf $(GO_TRUST_ALLOW_URL)/healthz >/dev/null 2>&1 && \
		   curl -sf $(GO_TRUST_DENY_URL)/healthz >/dev/null 2>&1 && \
		   curl -sf $(GO_TRUST_WHITELIST_URL)/healthz >/dev/null 2>&1; then \
			echo "$(GREEN)All services healthy!$(NC)"; break; \
		fi; \
		echo "  Waiting... ($$i/120)"; sleep 2; \
	done
	@# Final health checks
	@curl -sf $(FRONTEND_URL) >/dev/null || (echo "$(RED)Frontend not ready$(NC)"; exit 1)
	@curl -sf $(BACKEND_URL)/status >/dev/null || (echo "$(RED)Backend not ready$(NC)"; exit 1)
	@curl -sf $(GO_TRUST_ALLOW_URL)/healthz >/dev/null || (echo "$(RED)go-trust-allow not ready$(NC)"; exit 1)
	@curl -sf $(GO_TRUST_DENY_URL)/healthz >/dev/null || (echo "$(RED)go-trust-deny not ready$(NC)"; exit 1)
	@curl -sf $(GO_TRUST_WHITELIST_URL)/healthz >/dev/null || (echo "$(RED)go-trust-whitelist not ready$(NC)"; exit 1)
	@# Register mock issuer and verifier
	@$(MAKE) -s register-mocks
	@echo ""
	@echo "$(GREEN)Go-Trust environment ready$(NC)"
	@echo "  Allow:     $(GO_TRUST_ALLOW_URL)"
	@echo "  Deny:      $(GO_TRUST_DENY_URL)"
	@echo "  Whitelist: $(GO_TRUST_WHITELIST_URL)"

down-go-trust: ## Stop go-trust environment
	@echo "$(YELLOW)Stopping go-trust environment...$(NC)"
	-@FRONTEND_PATH=$(FRONTEND_PATH) BACKEND_PATH=$(BACKEND_PATH) GO_TRUST_PATH=$(GO_TRUST_PATH) \
		docker compose -f $(TEST_COMPOSE_FILE) -f $(GO_TRUST_COMPOSE) down -v 2>/dev/null || true
	@echo "$(GREEN)Environment stopped$(NC)"

test-go-trust: ## Run go-trust API tests
	@echo "$(GREEN)Running go-trust API tests...$(NC)"
	@curl -sf $(GO_TRUST_ALLOW_URL)/healthz >/dev/null || \
		(echo "$(RED)go-trust not running. Run 'make up-go-trust' first.$(NC)"; exit 1)
	$(TEST_ENV) GO_TRUST_ALLOW_URL=$(GO_TRUST_ALLOW_URL) \
		GO_TRUST_DENY_URL=$(GO_TRUST_DENY_URL) \
		GO_TRUST_WHITELIST_URL=$(GO_TRUST_WHITELIST_URL) \
		npx playwright test specs/api/go-trust.spec.ts --reporter=list

test-vc: ## Run tests with VC services (assumes up-vc was run)
	@echo "$(GREEN)Running tests with VC services...$(NC)"
	@curl -sf $(VC_ISSUER_URL)/health >/dev/null || \
		(echo "$(RED)VC Issuer not running. Run 'make up-vc' first.$(NC)"; exit 1)
	$(TEST_ENV) ISSUER_URL=$(VC_ISSUER_URL) VERIFIER_URL=$(VC_VERIFIER_URL) \
		npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

test-all-services: ## Run tests with mock services then VC services
	@echo "$(GREEN)╔════════════════════════════════════════════════════════════════╗$(NC)"
	@echo "$(GREEN)║       Running tests with all service configurations            ║$(NC)"
	@echo "$(GREEN)╚════════════════════════════════════════════════════════════════╝$(NC)"
	@echo ""
	@RESULTS_DIR="test-results/services-$$(date +%Y%m%d-%H%M%S)"; \
	mkdir -p "$$RESULTS_DIR"; \
	PASSED=0; FAILED=0; \
	echo "$(GREEN)━━━ Mock Services ━━━$(NC)"; \
	$(MAKE) down 2>/dev/null || true; \
	$(MAKE) up; \
	if $(MAKE) tests; then \
		echo "$(GREEN)✓ Mock services tests passed$(NC)"; PASSED=$$((PASSED + 1)); \
	else \
		echo "$(RED)✗ Mock services tests failed$(NC)"; FAILED=$$((FAILED + 1)); \
	fi; \
	$(MAKE) down; \
	echo ""; \
	echo "$(GREEN)━━━ VC Services ━━━$(NC)"; \
	$(MAKE) up-vc; \
	if $(MAKE) test-vc; then \
		echo "$(GREEN)✓ VC services tests passed$(NC)"; PASSED=$$((PASSED + 1)); \
	else \
		echo "$(RED)✗ VC services tests failed$(NC)"; FAILED=$$((FAILED + 1)); \
	fi; \
	$(MAKE) down-vc; \
	echo ""; \
	echo "$(GREEN)Summary: Passed=$$PASSED Failed=$$FAILED$(NC)"; \
	if [ $$FAILED -gt 0 ]; then exit 1; fi

check-backend-type: ## Display which backend type is running
	@echo "$(GREEN)Checking backend type...$(NC)"
	@STATUS=$$(curl -sf $(BACKEND_URL)/status 2>/dev/null); \
	if [ -z "$$STATUS" ]; then \
		echo "$(RED)Backend not reachable$(NC)"; exit 1; \
	fi; \
	SERVICE=$$(echo "$$STATUS" | grep -o '"service"[^,}]*' | cut -d'"' -f4); \
	VERSION=$$(echo "$$STATUS" | grep -o '"version"[^,}]*' | cut -d'"' -f4); \
	ROLES=$$(echo "$$STATUS" | grep -o '"roles":\[[^]]*\]'); \
	CAPS=$$(echo "$$STATUS" | grep -o '"capabilities":\[[^]]*\]'); \
	echo "  Service: $$SERVICE"; \
	[ -n "$$VERSION" ] && echo "  Version: $$VERSION"; \
	[ -n "$$ROLES" ] && echo "  Roles: $$ROLES"; \
	[ -n "$$CAPS" ] && echo "  Capabilities: $$CAPS"; \
	if echo "$$STATUS" | grep -q '"roles"'; then \
		echo "$(GREEN)Type: go-wallet-backend (supports modes and WebSocket)$(NC)"; \
	else \
		echo "$(YELLOW)Type: wallet-backend-server (HTTP only)$(NC)"; \
	fi

down: ## Stop Docker services
	@echo "$(YELLOW)Stopping Docker services...$(NC)"
	-@docker compose -f $(TEST_COMPOSE_FILE) down -v 2>/dev/null || true
	-@docker compose -f $(TEST_COMPOSE_FILE) -f $(TS_BACKEND_COMPOSE) down -v 2>/dev/null || true
	@echo "$(GREEN)Environment stopped$(NC)"

down-soft-fido2: stop-soft-fido2 down ## Stop soft-fido2 + Docker services

logs: ## View service logs
	docker compose -f $(TEST_COMPOSE_FILE) logs -f

status: ## Check service status
	@echo "$(GREEN)Service Status:$(NC)"
	@curl -sf $(FRONTEND_URL) >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Frontend: $(FRONTEND_URL)" || \
		echo "  $(RED)✗$(NC) Frontend: $(FRONTEND_URL)"
	@curl -sf $(BACKEND_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Backend: $(BACKEND_URL)" || \
		echo "  $(RED)✗$(NC) Backend: $(BACKEND_URL)"
	@curl -sf $(ENGINE_URL)/status >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Engine: $(ENGINE_URL)" || \
		echo "  $(RED)✗$(NC) Engine: $(ENGINE_URL)"
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

# Main test target - runs CDP tests (headless, CI-compatible)
test: test-api test-cdp ## Run all tests with CDP (API + WebAuthn)

tests: test ## Alias for 'test'

# CDP WebAuthn tests - fully headless, no display required
test-cdp: ## Run WebAuthn tests with CDP virtual authenticator (headless)
	@echo "$(GREEN)Running WebAuthn tests with CDP + PRF mock (headless)...$(NC)"
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test --config=playwright.webauthn-ci.config.ts --reporter=list

# Soft-FIDO2 tests - requires display (Xvfb or real display)
test-soft-fido2: test-api test-webauthn-browser ## Run tests with soft-fido2 authenticator

# WebAuthn UI tests (headed, requires display and soft-fido2)
test-webauthn-browser: ## Run WebAuthn UI tests with soft-fido2 (requires display)
	@echo "$(GREEN)Running WebAuthn UI tests with soft-fido2...$(NC)"
	@if [ ! -f "$(SOFT_FIDO2_PID)" ] || ! kill -0 $$(cat "$(SOFT_FIDO2_PID)") 2>/dev/null; then \
		echo "$(RED)soft-fido2 not running. Run 'make up-soft-fido2' first.$(NC)"; exit 1; \
	fi
	@curl -sf $(FRONTEND_URL) >/dev/null || \
		(echo "$(RED)Frontend not running. Run 'make up-soft-fido2' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# API tests (headless, fast)
test-api: ## Run API tests (headless)
	@echo "$(GREEN)Running API tests...$(NC)"
	@curl -sf $(BACKEND_URL)/status >/dev/null || \
		(echo "$(RED)Backend not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test specs/api/ --reporter=list

# Individual test targets for focused testing (using CDP by default)
test-credential: ## Run credential flow tests with CDP (issuance & verification)
	@echo "$(GREEN)Running credential flow tests (CDP)...$(NC)"
	$(TEST_ENV) npx playwright test --config=playwright.webauthn-ci.config.ts \
		--grep="Credential" --reporter=list

test-tenant: ## Run tenant selector tests with CDP
	@echo "$(GREEN)Running tenant selector tests (CDP)...$(NC)"
	$(TEST_ENV) npx playwright test --config=playwright.webauthn-ci.config.ts \
		--grep="TenantSelector" --reporter=list

test-registry: ## Run VCTM registry tests
	@echo "$(GREEN)Running VCTM registry tests...$(NC)"
	@curl -sf $(VCTM_REGISTRY_URL)/status >/dev/null || \
		(echo "$(RED)Registry not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test specs/api/registry.spec.ts --reporter=list

test-trust: ## Run trust integration tests with CDP
	@echo "$(GREEN)Running trust integration tests (CDP)...$(NC)"
	@curl -sf $(MOCK_PDP_URL)/health >/dev/null || \
		(echo "$(RED)Mock PDP not running. Run 'make up' first.$(NC)"; exit 1)
	$(TEST_ENV) npx playwright test --config=playwright.webauthn-ci.config.ts \
		--grep="Trust Integration" --reporter=list

# =============================================================================
# Transport Mode Testing
# =============================================================================

# Check if WebSocket is available from backend
check-ws-available: ## Check if backend supports WebSocket
	@echo "$(GREEN)Checking engine server capabilities...$(NC)"
	@STATUS=$$(curl -sf $(ENGINE_URL)/status 2>/dev/null); \
	if [ -z "$$STATUS" ]; then \
		echo "$(RED)Engine server not reachable$(NC)"; exit 1; \
	fi; \
	if echo "$$STATUS" | grep -q '"websocket"'; then \
		echo "$(GREEN)✓ WebSocket supported$(NC)"; \
	else \
		echo "$(YELLOW)✗ WebSocket not available$(NC)"; exit 1; \
	fi

# Run tests with HTTP transport only
test-http: ## Run tests with HTTP transport (forced)
	@echo "$(GREEN)Running tests with HTTP transport...$(NC)"
	$(TEST_ENV) TRANSPORT_MODE=http npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# Run tests with WebSocket transport only
test-ws: check-ws-available ## Run tests with WebSocket transport (forced)
	@echo "$(GREEN)Running tests with WebSocket transport...$(NC)"
	$(TEST_ENV) TRANSPORT_MODE=websocket npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# Run tests for all available transports
test-all-transports: ## Run test suite for each available transport
	@echo "$(GREEN)╔════════════════════════════════════════════════════════════════╗$(NC)"
	@echo "$(GREEN)║           Running tests for all transports                      ║$(NC)"
	@echo "$(GREEN)╚════════════════════════════════════════════════════════════════╝$(NC)"
	@echo ""
	@# Check backend
	@curl -sf $(BACKEND_URL)/status >/dev/null || \
		(echo "$(RED)Backend not running. Run 'make up' first.$(NC)"; exit 1)
	@# Determine available transports (check engine server for WebSocket)
	@WS_AVAILABLE=$$(curl -sf $(ENGINE_URL)/status 2>/dev/null | grep -q '"websocket"' && echo yes || echo no); \
	RESULTS_DIR="test-results/transports-$$(date +%Y%m%d-%H%M%S)"; \
	mkdir -p "$$RESULTS_DIR"; \
	PASSED=0; FAILED=0; \
	echo ""; \
	echo "$(GREEN)━━━ HTTP Transport ━━━$(NC)"; \
	if $(TEST_ENV) TRANSPORT_MODE=http npx playwright test --config=playwright.real-webauthn.config.ts \
		--reporter=html --output="$$RESULTS_DIR/http" 2>&1; then \
		echo "$(GREEN)✓ HTTP tests passed$(NC)"; PASSED=$$((PASSED + 1)); \
	else \
		echo "$(RED)✗ HTTP tests failed$(NC)"; FAILED=$$((FAILED + 1)); \
	fi; \
	cp -r playwright-report "$$RESULTS_DIR/http-report" 2>/dev/null || true; \
	echo ""; \
	if [ "$$WS_AVAILABLE" = "yes" ]; then \
		echo "$(GREEN)━━━ WebSocket Transport ━━━$(NC)"; \
		if $(TEST_ENV) TRANSPORT_MODE=websocket npx playwright test --config=playwright.real-webauthn.config.ts \
			--reporter=html --output="$$RESULTS_DIR/websocket" 2>&1; then \
			echo "$(GREEN)✓ WebSocket tests passed$(NC)"; PASSED=$$((PASSED + 1)); \
		else \
			echo "$(RED)✗ WebSocket tests failed$(NC)"; FAILED=$$((FAILED + 1)); \
		fi; \
		cp -r playwright-report "$$RESULTS_DIR/websocket-report" 2>/dev/null || true; \
	else \
		echo "$(YELLOW)⏭ Skipping WebSocket (not supported by backend)$(NC)"; \
	fi; \
	echo ""; \
	echo "$(GREEN)╔════════════════════════════════════════════════════════════════╗$(NC)"; \
	echo "$(GREEN)║                       Summary                                   ║$(NC)"; \
	echo "$(GREEN)╚════════════════════════════════════════════════════════════════╝$(NC)"; \
	echo ""; \
	echo "Results: $$RESULTS_DIR"; \
	echo "  Passed: $$PASSED"; \
	echo "  Failed: $$FAILED"; \
	if [ $$FAILED -gt 0 ]; then exit 1; fi

# =============================================================================
# CI Targets
# =============================================================================

tests-ci: test ## Run all CI tests (now same as 'test' - CDP by default)

test-api-ci: test-api ## Run API tests in CI (alias)

test-webauthn-cdp-ci: test-cdp ## Run WebAuthn tests with CDP (alias)

# Legacy Xvfb-based soft-fido2 tests (requires display server)
test-webauthn-xvfb: ## Run WebAuthn tests with Xvfb (soft-fido2, requires display)
	@echo "$(GREEN)Running WebAuthn UI tests with Xvfb...$(NC)"
	@command -v xvfb-run >/dev/null 2>&1 || \
		(echo "$(RED)xvfb-run not found. Install: apt-get install xvfb$(NC)"; exit 1)
	xvfb-run -a --server-args="-screen 0 1920x1080x24" \
		env $(TEST_ENV) npx playwright test --config=playwright.real-webauthn.config.ts --reporter=list

# Full CI cycle (CDP based - no display required)
ci: up test down ## Full CI: start → test → cleanup

# Comprehensive CI (includes soft-fido2 tests via Xvfb)
ci-full: up-soft-fido2 test test-webauthn-xvfb down-soft-fido2 ## Full CI with soft-fido2 tests

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

run: test ## Alias for 'test'
test-webauthn: test-cdp ## Alias for 'test-cdp' (CDP is now default)
test-real-webauthn: test-webauthn-browser ## Alias for 'test-webauthn-browser' (soft-fido2)
test-webauthn-ci: test-cdp ## Alias for 'test-cdp' (CDP is now default)
test-real-webauthn-ci: test-webauthn-xvfb ## Alias for 'test-webauthn-xvfb' (soft-fido2 with Xvfb)
test-credential-flow: test-credential ## Alias for 'test-credential'
ci-docker: ci ## Alias for 'ci'
ci-real-webauthn: ci ## Alias for 'ci'

.DEFAULT_GOAL := help
