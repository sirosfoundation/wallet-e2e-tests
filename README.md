# Wallet E2E Tests

End-to-end tests for the wallet stack (`wallet-frontend` + `go-wallet-backend`) with WebAuthn PRF support.

[![E2E Tests](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml/badge.svg)](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml)

## Overview

This repository provides:

1. **Real WebAuthn E2E tests** using soft-fido2 virtual FIDO2 authenticator
2. **Multi-tenancy tests** for header-based tenant isolation (X-Tenant-ID)
3. **API compatibility tests** for discover and trust functionality
4. **Reusable GitHub Action** for CI/CD pipelines

## Quick Start (Real WebAuthn Tests)

**Prerequisites:**
- Linux with UHID kernel module (for soft-fido2)
- Docker and Docker Compose
- X11 display (or Xvfb for headless)

```bash
# 1. Install dependencies
make install

# 2. Start test environment with soft-fido2 virtual authenticator
SOFT_FIDO2_PATH=/path/to/soft-fido2 make up

# 3. Run real WebAuthn tests (requires display - runs in headed mode)
make test-real-webauthn

# 4. Stop environment
make down
```

For **CI environments** without a display:
```bash
make test-real-webauthn-ci  # Uses Xvfb
```

See [REAL_WEBAUTHN_TESTING.md](REAL_WEBAUTHN_TESTING.md) for detailed soft-fido2 setup instructions.

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
├── .github/workflows/           # GitHub Actions
│   ├── e2e-tests.yml            # Reusable workflow
│   └── self-test.yml            # Self-test on push
├── docs/
│   ├── CI.md                    # CI integration guide
│   └── discover-and-trust-tests.md
├── helpers/
│   ├── real-webauthn.ts         # Real WebAuthn helper
│   ├── tenant-api.ts            # Admin tenant API helper
│   ├── issuer-api.ts            # Admin issuer API helper
│   └── trust-api.ts             # Trust API helper
├── mocks/                       # Mock services (issuer, verifier, PDP)
├── specs/
│   ├── api/                     # API tests (discover, trust, admin)
│   └── real-webauthn/           # Real WebAuthn user flow tests
├── scripts/
│   ├── start-soft-fido2.sh      # Start soft-fido2 daemon
│   └── stop-soft-fido2.sh       # Stop soft-fido2 daemon
├── docker-compose.test.yml      # Full test environment
├── Makefile                     # Build automation
├── playwright.config.ts         # Default Playwright config
├── playwright.real-webauthn.config.ts  # Real WebAuthn config (headed)
└── REAL_WEBAUTHN_TESTING.md     # Detailed soft-fido2 documentation
```

## Test Categories

| Directory | Description | Config |
|-----------|-------------|--------|
| `specs/real-webauthn/` | Full user flows with real WebAuthn (soft-fido2) | `playwright.real-webauthn.config.ts` |
| `specs/api/` | API tests (discover, trust, admin, compatibility) | `playwright.config.ts` |

### Running Specific Tests

```bash
# Real WebAuthn tests (requires soft-fido2 and display)
make test-real-webauthn

# API-only tests (headless, no soft-fido2 needed)
npx playwright test specs/api/

# Specific test file
npx playwright test specs/api/discover-and-trust.spec.ts
```

## Real WebAuthn with soft-fido2

The primary test approach uses **real browser WebAuthn** with the soft-fido2 UHID virtual authenticator. This provides:

- Full CTAP2 protocol support (no mocking)
- Real hmac-secret extension (WebAuthn PRF works correctly)
- Discoverable credentials (resident keys)
- Actual browser → authenticator interaction

**Key advantages over CDP virtual authenticators:**
- Tests exercise the real browser WebAuthn stack
- PRF extension works correctly (CDP returns empty results)
- Same code path as real hardware authenticators

See [REAL_WEBAUTHN_TESTING.md](REAL_WEBAUTHN_TESTING.md) for setup and architecture details.

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

### soft-fido2 not starting

1. Ensure UHID kernel module is loaded: `sudo modprobe uhid`
2. Add user to fido group: `sudo usermod -a -G fido $USER`
3. Check permissions: `ls -la /dev/uhid`
4. View logs: `tail -f /tmp/soft-fido2.log`

### WebAuthn ceremony fails

1. Ensure `RP_ORIGIN` matches the frontend URL exactly
2. Check soft-fido2 is running: `make status`
3. Verify browser can see the authenticator (check browser WebAuthn settings)

### Tests timeout

WebAuthn tests need extra time. The config uses:
- `fullyParallel: false`
- `workers: 1`
- `timeout: 60000`

### No browser window appears

Real WebAuthn tests require headed mode. Use:
- `make test-real-webauthn` (needs X11 display)
- `make test-real-webauthn-ci` (uses Xvfb virtual display)

## License

MIT
