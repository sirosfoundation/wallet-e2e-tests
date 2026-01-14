# Wallet E2E Tests

End-to-end tests for the wallet stack (wallet-frontend + go-wallet-backend) with WebAuthn PRF support.

## Overview

This repository contains E2E tests that verify the integration between wallet-frontend and go-wallet-backend. The tests use Playwright with Chrome DevTools Protocol (CDP) to create virtual WebAuthn authenticators, and include a PRF mock that provides actual HMAC-SHA256 PRF outputs required by the wallet's keystore.

## Key Features

- **PRF Mock**: Works around Chrome's CDP limitation where virtual authenticators report PRF support but return empty results
- **Virtual Authenticator**: Uses CDP to create platform and security key authenticators
- **Version Matrix Testing**: Test different combinations of frontend/backend versions
- **Docker Support**: Run tests in isolated containers

## Quick Start

### Prerequisites

- Node.js 18+
- Go 1.21+ (for running backend locally)
- Docker and Docker Compose (for containerized testing)

### Installation

```bash
npm install
npx playwright install chromium
```

### Running Tests

#### Option 1: Against running servers

If you already have wallet-frontend and go-wallet-backend running:

```bash
FRONTEND_URL=http://localhost:3000 BACKEND_URL=http://localhost:8080 npm test
```

#### Option 2: Auto-start servers

```bash
START_SERVERS=true \
FRONTEND_PATH=../wallet-frontend \
BACKEND_PATH=../go-wallet-backend \
npm test
```

#### Option 3: Using setup script

```bash
./scripts/setup-local.sh --frontend-path ../wallet-frontend --backend-path ../go-wallet-backend
# In another terminal:
npm test
```

#### Option 4: Using Docker

```bash
docker-compose up -d
npm test
docker-compose down
```

### Running Specific Tests

```bash
# PRF mock tests only
npm run test:prf

# Registration tests only
npm run test:registration

# Login tests only
npm run test:login

# Interactive UI mode
npm run test:ui

# With browser visible
npm run test:headed
```

## Test Structure

```
wallet-e2e-tests/
├── helpers/
│   └── webauthn.ts       # WebAuthn helper with PRF mock
├── specs/
│   ├── prf/              # PRF mock tests
│   ├── registration/     # Registration flow tests
│   └── login/            # Login flow tests
├── scripts/
│   ├── run-matrix.sh     # Version matrix testing
│   └── setup-local.sh    # Local development setup
├── docker-compose.yml    # Docker configuration
└── playwright.config.ts  # Playwright configuration
```

## PRF Mock

Chrome's CDP virtual authenticator reports `hasPrf=true` but doesn't actually compute PRF outputs. The `WebAuthnHelper.injectPrfMock()` method patches the WebAuthn API to compute real HMAC-SHA256 based PRF outputs:

```typescript
// In your test setup
test.beforeEach(async ({ page }) => {
  webauthn = new WebAuthnHelper(page);
  await webauthn.initialize();
  await webauthn.injectPrfMock();  // CRITICAL: Must be before navigation
  await webauthn.addPlatformAuthenticator();
});
```

The mock:
- Generates a deterministic PRF seed for each credential
- Computes HMAC-SHA256(seed, salt) for PRF outputs
- Produces same output for same credential+salt (deterministic)
- Produces different output for different salts

## Version Matrix Testing

Test different combinations of frontend and backend versions:

```bash
./scripts/run-matrix.sh \
  --frontend-versions "v1.0.0 v1.1.0 latest" \
  --backend-versions "v1.0.0 v1.1.0 latest"
```

This generates a compatibility matrix and saves results to `test-results/matrix-*/`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_URL` | `http://localhost:3000` | URL of wallet-frontend |
| `BACKEND_URL` | `http://localhost:8080` | URL of go-wallet-backend |
| `START_SERVERS` | `false` | Auto-start servers |
| `FRONTEND_PATH` | `../wallet-frontend` | Path to frontend repo |
| `BACKEND_PATH` | `../go-wallet-backend` | Path to backend repo |
| `FRONTEND_VERSION` | `latest` | Docker image version |
| `BACKEND_VERSION` | `latest` | Docker image version |

## Backend Configuration

The backend requires specific configuration for WebAuthn to work correctly:

```bash
WALLET_JWT_SECRET=test-secret-for-e2e-testing-minimum-32-chars
WALLET_SERVER_WEBAUTHN_DISPLAY_NAME=Wallet E2E Test
WALLET_SERVER_RP_ID=localhost
WALLET_SERVER_RP_ORIGIN=http://localhost:3000  # Must match frontend origin!
WALLET_SERVER_ENABLE_CREDENTIAL_REGISTRATION=true
WALLET_SERVER_REQUIRE_USER_VERIFICATION=true
WALLET_SERVER_TIMEOUT=60000
WALLET_SERVER_ATTESTATION=none
```

## Troubleshooting

### PRF outputs are empty

Make sure to call `injectPrfMock()` **before** any page navigation:

```typescript
await webauthn.initialize();
await webauthn.injectPrfMock();  // Must be BEFORE page.goto()
await webauthn.addPlatformAuthenticator();
await page.goto('/');  // Navigation comes after
```

### WebAuthn ceremony fails

Check that:
1. `WALLET_SERVER_RP_ORIGIN` matches the frontend URL exactly
2. `WALLET_SERVER_RP_ID` matches the hostname (e.g., `localhost`)
3. Virtual authenticator is added before triggering WebAuthn

### Tests timeout

WebAuthn tests require serial execution and need extra time. The config sets:
- `fullyParallel: false`
- `workers: 1`
- `timeout: 60000`

## License

MIT
