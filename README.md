# Wallet E2E Tests

End-to-end tests for the wallet stack (`wallet-frontend` + `go-wallet-backend`) with WebAuthn PRF support.

[![E2E Tests](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml/badge.svg)](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml)

## Overview

This repository provides:

1. **E2E test suite** for wallet-frontend and go-wallet-backend integration
2. **Reusable GitHub Action** for CI/CD pipelines
3. **PRF mock** that works around Chrome CDP limitations
4. **Multi-tenancy tests** for tenant isolation verification
5. **Trust API tests** for discover and trust functionality

## Quick Start

```bash
# Install dependencies
make install

# Start test environment
make up

# Run all tests
make run

# Stop environment
make down
```

## CI/CD Integration

Use the reusable workflow in your repository (works with forks):

**Default repositories:**
- Frontend: `https://github.com/wwWallet/wallet-frontend.git`
- Backend: `https://github.com/sirosfoundation/go-wallet-backend.git`

**For wallet-frontend (or fork):**
```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      frontend-repo: ${{ github.server_url }}/${{ github.repository }}.git
      backend-refs: '["main", "v1.0.0"]'
```

**For go-wallet-backend (or fork):**
```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      backend-ref: ${{ github.sha }}
      backend-repo: ${{ github.server_url }}/${{ github.repository }}.git
      frontend-refs: '["master", "v1.0.0"]'
```

See [docs/CI.md](docs/CI.md) for detailed CI integration documentation.

## Local Development

### Using Make Targets (Recommended)

```bash
# Show all available targets
make help

# Install dependencies and Playwright
make install

# Start the test environment (Docker Compose)
make up

# Check service status
make status

# Run all tests
make run

# View service logs
make logs

# Stop the environment
make down

# Full CI cycle (up + run + down)
make ci-docker
```

### Debug Options

```bash
make test-headed  # Run with visible browser
make test-debug   # Run with debugger attached
make test-ui      # Open Playwright UI
```

### Configuration Variables

Pass variables to customize the environment:

```bash
make run FRONTEND_URL=http://custom:3000 BACKEND_URL=http://custom:8080
```

## Test Structure

```
wallet-e2e-tests/
├── .github/workflows/     # GitHub Actions
│   ├── e2e-tests.yml      # Reusable workflow
│   └── self-test.yml      # Self-test on push
├── docs/
│   └── CI.md              # CI integration guide
├── helpers/
│   └── webauthn.ts        # WebAuthn/PRF helper
├── specs/
│   ├── api/               # API tests (discover, trust, verifier)
│   ├── authenticated/     # Authenticated flow tests
│   ├── diagnostics/       # Diagnostic tests
│   ├── full-flow/         # Complete flow tests
│   ├── login/             # Login tests
│   ├── multi-tenancy/     # Multi-tenancy tests
│   ├── prf/               # PRF mock tests
│   └── registration/      # Registration tests
├── scripts/
│   ├── run-matrix.sh      # Version matrix testing
│   └── setup-local.sh     # Local dev setup
├── docker-compose.yml         # Docker configuration
├── docker-compose.test.yml    # Full test environment
├── Makefile                   # Build automation
└── playwright.config.ts       # Playwright config
```

## Test Categories

Tests are organized by functionality:

| Directory | Description |
|-----------|-------------|
| `specs/api/` | API tests (discover, trust, verifier) |
| `specs/multi-tenancy/` | Tenant isolation tests |
| `specs/registration/` | Registration flow tests |
| `specs/login/` | Login flow tests |
| `specs/prf/` | PRF extension tests |
| `specs/full-flow/` | Complete flow tests |

Run specific tests with Playwright grep:

```bash
npx playwright test --grep "@multi-tenancy"
npx playwright test specs/api/
```

## PRF Mock

Chrome's CDP virtual authenticator reports `hasPrf=true` but returns empty PRF results. The PRF mock patches the WebAuthn API to compute actual HMAC-SHA256 outputs:

```typescript
test.beforeEach(async ({ page }) => {
  webauthn = new WebAuthnHelper(page);
  await webauthn.initialize();
  await webauthn.injectPrfMock();  // CRITICAL: Before navigation
  await webauthn.addPlatformAuthenticator();
});
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL |
| `BACKEND_URL` | `http://localhost:8080` | Backend URL |
| `ADMIN_URL` | `http://localhost:8081` | Admin API URL |
| `ADMIN_TOKEN` | (required for multi-tenancy) | Admin API authentication token |
| `MOCK_ISSUER_URL` | `http://localhost:9000` | Mock issuer URL |
| `MOCK_VERIFIER_URL` | `http://localhost:9001` | Mock verifier URL |
| `MOCK_PDP_URL` | `http://localhost:9091` | Mock PDP URL |

## Backend Configuration

Required environment variables for go-wallet-backend:

```bash
RP_ORIGIN=http://localhost:3000  # Must match frontend URL!
WALLET_SERVER_RP_ID=localhost
WALLET_JWT_SECRET=test-secret-for-e2e-testing-minimum-32-chars
```

## Troubleshooting

### PRF outputs are empty

Call `injectPrfMock()` **before** any page navigation.

### WebAuthn ceremony fails

Ensure `RP_ORIGIN` matches the frontend URL exactly.

### Tests timeout

WebAuthn tests need extra time. The config uses:
- `fullyParallel: false`
- `workers: 1`
- `timeout: 60000`

## License

MIT
