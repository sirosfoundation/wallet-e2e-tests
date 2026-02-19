# ADR-001: Consolidated E2E Test Architecture

## Status
Accepted

## Date
2026-02-19

## Context

The wallet-e2e-tests repository has evolved over time with multiple testing approaches:

1. **CDP Virtual Authenticator** - Using Chrome DevTools Protocol to mock WebAuthn
2. **Real WebAuthn with soft-fido2** - Using a real virtual FIDO2 authenticator

The CDP approach was deprecated because:
- Chrome's CDP virtual authenticator reports `hasPrf=true` but returns empty PRF results
- Required extensive mocking/patching that was brittle and complex
- Tests didn't match real-world browser behavior

The real WebAuthn approach with soft-fido2 provides:
- Actual PRF extension support that works correctly
- Tests reflect real browser behavior
- No CDP mocking required
- Requires headed mode and a display (or Xvfb for CI)

## Decision

### Test Categories

We organize tests into two main categories:

1. **API Tests** (`specs/api/`) - Headless
   - Pure API endpoint testing without browser UI
   - Run with default Playwright config (headless)
   - Fast execution, no display required
   
2. **WebAuthn UI Tests** (`specs/real-webauthn/`) - Headed
   - Full user flow testing through the wallet-frontend UI
   - Require soft-fido2 virtual authenticator
   - Run with `playwright.real-webauthn.config.ts` (headed mode)
   - Require display (X11 or Xvfb)

### Test Files

**API Tests** (headless, fast):
```
specs/api/
├── admin-api.spec.ts        # Admin tenant/issuer CRUD
├── api-compatibility.spec.ts # Backend API format tests
├── discover-and-trust.spec.ts # Trust API v2 tests
├── registry.spec.ts         # VCTM registry tests
└── verifier-trust.spec.ts   # Verifier trust evaluation
```

**WebAuthn UI Tests** (headed, requires soft-fido2):
```
specs/real-webauthn/
├── user-flows.spec.ts       # Registration, login, multi-tenancy
├── credential-flow.spec.ts  # Full VCI/VP issuance & verification
└── tenant-selector.spec.ts  # TenantSelector component tests
```

### Shared Helpers

Common code is extracted to `helpers/`:
- `helpers/ui-actions.ts` - Shared UI interaction helpers (registerUserViaUI, loginUserViaUI, etc.)
- `helpers/tenant-api.ts` - Admin tenant API helpers
- `helpers/issuer-api.ts` - Admin issuer API helpers
- `helpers/trust-api.ts` - Trust API helpers
- `helpers/browser-storage.ts` - localStorage/sessionStorage helpers
- `helpers/real-webauthn.ts` - WebAuthn credential tracking

### Deprecated Helpers

The following are deprecated and will be removed:
- `helpers/webauthn.ts` - CDP-based virtual authenticator (replaced by soft-fido2)

### Makefile Workflow

The primary workflow is:

```bash
# Start test environment (soft-fido2 + Docker services)
make up

# Run all tests (default target)
make tests

# Stop everything
make down
```

Individual test targets for focused testing:
```bash
make test-api          # API tests only (headless)
make test-webauthn     # WebAuthn UI tests only (headed)
make test-credential   # Credential flow tests only
make test-tenant       # Tenant selector tests only
```

### Environment Variables

Default configuration assumes sibling directory layout:

```
workspace/
├── wallet-e2e-tests/     # This repository
├── wallet-frontend/      # React frontend
├── go-wallet-backend/    # Go backend
└── soft-fido2/          # Virtual FIDO2 authenticator
```

Key environment variables:
| Variable | Default | Description |
|----------|---------|-------------|
| `SOFT_FIDO2_PATH` | `../soft-fido2` | Path to soft-fido2 |
| `FRONTEND_PATH` | `../wallet-frontend` | Path to frontend |
| `BACKEND_PATH` | `../go-wallet-backend` | Path to backend |
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL |
| `BACKEND_URL` | `http://localhost:8080` | Backend URL |
| `ADMIN_URL` | `http://localhost:8081` | Admin API URL |
| `ADMIN_TOKEN` | `e2e-test-admin-token...` | Admin API token |
| `ISSUER_URL` | `http://localhost:9000` | Mock issuer URL |
| `VERIFIER_URL` | `http://localhost:9001` | Mock verifier URL |
| `VCTM_REGISTRY_URL` | `http://localhost:8097` | VCTM registry URL |

### CI Execution

For CI environments without a display:
```bash
# Uses Xvfb virtual display
make tests-ci
```

The CI workflow:
1. Starts soft-fido2 virtual authenticator
2. Starts Docker Compose services
3. Runs API tests (headless)
4. Runs WebAuthn tests under Xvfb
5. Cleans up

## Consequences

### Positive
- Simpler test structure with clear separation
- Real WebAuthn behavior testing
- PRF extension works correctly
- Shared helpers reduce code duplication
- Clear `make up && make tests && make down` workflow

### Negative
- WebAuthn tests require a display (X11 or Xvfb)
- Headed tests are slower than headless
- soft-fido2 requires Linux with UHID kernel module

### Neutral
- API tests remain unchanged (headless, fast)
- Docker Compose environment unchanged
