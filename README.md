# Wallet E2E Tests

End-to-end tests for the wallet stack (`wallet-frontend` + `go-wallet-backend`) using real WebAuthn with soft-fido2.

## Quick Start

```bash
# 1. Install dependencies
make install

# 2. Start test environment
make up

# 3. Run all tests
make tests

# 4. Stop environment
make down
```

## Prerequisites

- **Linux** with UHID kernel module (for soft-fido2)
- **Docker** and Docker Compose
- **X11 display** (or Xvfb for headless CI)
- **Node.js** 18+

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
| `make tests` | Run all tests (API + WebAuthn UI) |
| `make test-api` | API tests only (headless, fast) |
| `make test-webauthn` | WebAuthn UI tests (headed, requires display) |
| `make test-credential` | Credential issuance & verification flow |
| `make test-tenant` | Tenant selector component tests |
| `make test-registry` | VCTM registry API tests |
| `make test-trust` | Trust integration tests (go-trust compatibility) |

## CI Usage

For CI environments without a display:
```bash
make tests-ci    # Uses Xvfb virtual display
```

Full CI cycle:
```bash
make ci          # start → test → cleanup
```

### GitHub Actions

Use the reusable workflow:

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      frontend-repo: ${{ github.repository }}
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
│   │   ├── api-compatibility.spec.ts
│   │   ├── discover-and-trust.spec.ts
│   │   ├── registry.spec.ts     # VCTM registry
│   │   └── verifier-trust.spec.ts
│   └── real-webauthn/           # WebAuthn UI tests (headed)
│       ├── user-flows.spec.ts   # Registration, login, multi-tenancy
│       ├── credential-flow.spec.ts  # VCI/VP flows
│       ├── tenant-selector.spec.ts
│       └── trust-integration.spec.ts  # Trust/go-trust integration
├── helpers/                     # Shared test utilities
│   ├── ui-actions.ts            # UI interaction helpers
│   ├── tenant-api.ts            # Admin tenant API
│   ├── issuer-api.ts            # Admin issuer API
│   └── trust-api.ts             # Trust API helpers
├── mocks/                       # Mock issuer, verifier, PDP
│   ├── issuer/                  # OpenID4VCI mock issuer
│   ├── verifier/                # OpenID4VP mock verifier
│   └── trust-pdp/               # Mock AuthZEN PDP (go-trust compatible)
├── playwright.config.ts         # Default config (API tests)
└── playwright.real-webauthn.config.ts  # WebAuthn config (headed)
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
