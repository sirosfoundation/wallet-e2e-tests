# Wallet E2E Tests

End-to-end tests for the wallet stack (`wallet-frontend` + `go-wallet-backend`) using CDP Virtual Authenticator (headless) or soft-fido2 (browser-based).

## Quick Start (CDP - Headless)

```bash
# 1. Install dependencies
make install

# 2. Start Docker services
make up

# 3. Run all tests with CDP virtual authenticator
make test

# 4. Stop services
make down
```

This runs 50+ tests including user registration, credential issuance, trust integration, and tenant management - all headless without requiring a display or soft-fido2.

## Soft-FIDO2 (Browser-Based)

For full browser testing with soft-fido2 virtual authenticator:

```bash
# Requires Linux with X11 display or Xvfb
make up-soft-fido2       # Start soft-fido2 + Docker services
make test-soft-fido2     # Run browser-based tests
make down-soft-fido2     # Stop everything
```

## Prerequisites

**CDP Testing (Default):**
- Docker and Docker Compose
- Node.js 18+

**Soft-FIDO2 Testing (Optional):**
- Linux with UHID kernel module
- X11 display (or Xvfb for headless CI)
- soft-fido2 repository cloned

## Workspace Layout

The Makefile assumes sibling directories:

```
workspace/
├── wallet-e2e-tests/     # This repository
├── wallet-frontend/      # React frontend (wwWallet/wallet-frontend)
├── go-wallet-backend/    # Go backend (sirosfoundation/go-wallet-backend)
└── soft-fido2/          # Virtual FIDO2 authenticator (pando85/soft-fido2)
```

Override paths if different:
```bash
make up SOFT_FIDO2_PATH=/path/to/soft-fido2 FRONTEND_PATH=/path/to/frontend
```

## Test Targets

| Target | Description |
|--------|-------------|
| `make test` | Run all tests with CDP (API + WebAuthn) |
| `make test-api` | API tests only (headless, fast) |
| `make test-cdp` | CDP WebAuthn tests (headless) |
| `make test-credential` | Credential issuance & verification (CDP) |
| `make test-tenant` | Tenant selector tests (CDP) |
| `make test-trust` | Trust integration tests (CDP) |
| `make test-registry` | VCTM registry API tests |
| `make test-soft-fido2` | Full browser tests with soft-fido2 |

## CI Usage

CDP tests run headless without any display requirements:
```bash
make ci          # up → test → down (fully headless)
```

For soft-fido2 browser tests in CI (requires Xvfb):
```bash
make ci-full     # Includes soft-fido2 tests via Xvfb
```

### GitHub Actions

**wallet-e2e-tests** provides the `frontend-ci.yml` workflow that can be triggered:

1. **Manually** via workflow_dispatch:
   - Go to Actions → "Frontend CI (CDP)" → Run workflow
   - Specify wallet-frontend ref/repo and backend ref

2. **Automatically** from wallet-frontend via repository_dispatch:
   - wallet-frontend pushes trigger E2E tests
   - Tests run against the specific frontend commit

#### Setting up Cross-Repo Triggers

To enable wallet-frontend to trigger E2E tests:

1. Create a GitHub PAT (classic or fine-grained) with `repo` scope
2. Add it as a secret `E2E_TESTS_TOKEN` in wallet-frontend repo
3. The `e2e-tests.yml` workflow in wallet-frontend will trigger tests automatically

```yaml
# Example: Trigger from another workflow
- name: Trigger E2E Tests
  uses: peter-evans/repository-dispatch@v3
  with:
    token: ${{ secrets.E2E_TESTS_TOKEN }}
    repository: sirosfoundation/wallet-e2e-tests
    event-type: frontend-ci
    client-payload: |
      {
        "frontend_ref": "${{ github.sha }}",
        "frontend_repo": "${{ github.repository }}",
        "backend_ref": "main"
      }
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOFT_FIDO2_PATH` | `../soft-fido2` | Path to soft-fido2 |
| `FRONTEND_PATH` | `../wallet-frontend` | Path to wallet-frontend |
| `BACKEND_PATH` | `../go-wallet-backend` | Path to go-wallet-backend |
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL |
| `BACKEND_URL` | `http://localhost:8080` | Backend URL |
| `ADMIN_URL` | `http://localhost:8081` | Admin API URL |
| `ADMIN_TOKEN` | `e2e-test-admin-token...` | Admin API token |
| `ISSUER_URL` | `http://localhost:9000` | Mock issuer URL |
| `VERIFIER_URL` | `http://localhost:9001` | Mock verifier URL |
| `VCTM_REGISTRY_URL` | `http://localhost:8097` | VCTM registry URL |

## Test Structure

```
wallet-e2e-tests/
├── specs/
│   ├── api/                     # API tests (headless)
│   │   ├── admin-api.spec.ts    # Admin tenant/issuer CRUD
│   │   ├── registry.spec.ts     # VCTM registry
│   │   └── ...
│   ├── shared/                  # Shared test modules (CDP + soft-fido2)
│   │   ├── user-flows.shared.ts       # Registration, login
│   │   ├── credential-flow.shared.ts  # VCI issuance, credential rename
│   │   ├── tenant-selector.shared.ts  # TenantSelector component
│   │   ├── trust-integration.shared.ts # PDP/AuthZEN tests
│   │   ├── tenant-routing.shared.ts   # URL routing
│   │   └── backend-capabilities.shared.ts
│   ├── webauthn-ci/             # CDP test entry points
│   │   ├── shared-tests.spec.ts # Imports shared modules
│   │   └── user-flows.spec.ts   # CDP-specific tests
│   └── real-webauthn/           # Soft-fido2 test entry points
│       ├── shared-tests.spec.ts # Imports shared modules
│       ├── credential-flow.spec.ts
│       └── ...
├── helpers/                     # Test utilities
├── mocks/                       # Mock issuer, verifier, PDP
├── playwright.config.ts         # API tests config
├── playwright.webauthn-ci.config.ts   # CDP config (headless)
└── playwright.real-webauthn.config.ts # Soft-fido2 config (headed)
```

## Debug Options

```bash
make test-headed  # Run with visible browser
make test-debug   # Run with Playwright debugger
make test-ui      # Open Playwright UI mode
```

## Documentation

- [Architecture Decision Record](docs/adr/001-consolidated-test-architecture.md)
- [CI Integration Guide](docs/CI.md)
- [soft-fido2 Setup](REAL_WEBAUTHN_TESTING.md)
