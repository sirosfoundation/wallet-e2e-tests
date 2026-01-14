# Wallet E2E Tests

End-to-end tests for the wallet stack (`wallet-frontend` + `go-wallet-backend`) with WebAuthn PRF support.

[![E2E Tests](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml/badge.svg)](https://github.com/sirosfoundation/wallet-e2e-tests/actions/workflows/self-test.yml)

## Overview

This repository provides:

1. **E2E test suite** for wallet-frontend and go-wallet-backend integration
2. **Reusable GitHub Action** for CI/CD pipelines
3. **PRF mock** that works around Chrome CDP limitations
4. **Version matrix testing** for compatibility verification

## Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Run tests (servers must be running)
npm test
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

### Option 1: Manual server setup

Start servers manually and run tests:

```bash
# Terminal 1: Start backend
cd ../go-wallet-backend
RP_ORIGIN=http://localhost:3000 go run ./cmd/server/...

# Terminal 2: Start frontend  
cd ../wallet-frontend
VITE_WALLET_BACKEND_URL=http://localhost:8080 npm run dev

# Terminal 3: Run tests
cd wallet-e2e-tests
npm test
```

### Option 2: Makefile automation

```bash
# Clone and test specific git refs
make setup-git FRONTEND_REF=master BACKEND_REF=main
make test
make teardown

# Or test from existing local checkouts
make setup-local FRONTEND_PATH=../wallet-frontend BACKEND_PATH=../go-wallet-backend
make test
make teardown
```

### Option 3: Docker

```bash
docker-compose up -d
npm test
docker-compose down
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
│   ├── api/               # API compatibility tests
│   ├── authenticated/     # Authenticated flow tests
│   ├── diagnostics/       # Diagnostic tests
│   ├── full-flow/         # Complete flow tests
│   ├── login/             # Login tests
│   ├── prf/               # PRF mock tests
│   └── registration/      # Registration tests
├── scripts/
│   ├── run-matrix.sh      # Version matrix testing
│   └── setup-local.sh     # Local dev setup
├── docker-compose.yml     # Docker configuration
├── Makefile               # Build automation
└── playwright.config.ts   # Playwright config
```

## Test Tags

Run specific test categories:

```bash
npm run test:prf          # @prf - PRF extension tests
npm run test:registration # @registration - Registration flows
npm run test:login        # @login - Login flows
```

Or use Playwright grep:

```bash
npx playwright test --grep "@full-flow"
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
| `FRONTEND_PATH` | `../wallet-frontend` | Frontend repo path |
| `BACKEND_PATH` | `../go-wallet-backend` | Backend repo path |
| `FRONTEND_REF` | `master` | Frontend git ref |
| `BACKEND_REF` | `main` | Backend git ref |

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
