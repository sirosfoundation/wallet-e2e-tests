# Discover and Trust E2E Tests

This directory contains E2E tests for the discover-and-trust API endpoint,
which combines metadata discovery with trust evaluation.

## Test Structure

```
specs/api/
  discover-and-trust.spec.ts   # Main E2E test spec

helpers/
  trust-api.ts                 # API helper class for trust endpoints

mocks/
  issuer/                      # Mock OpenID4VCI credential issuer
  verifier/                    # Mock OpenID4VP verifier
  trust-pdp/                   # Mock AuthZEN policy decision point
```

## Test Categories

Tests are tagged for selective execution:

- `@api` - API contract tests
- `@trust` - Trust evaluation tests
- `@mock` - Tests requiring mock services
- `@pdp` - Tests requiring AuthZEN PDP

## Running Tests

### Basic API Tests (no mock services required)

```bash
npx playwright test --grep "@api" --grep-invert "@mock"
```

### With Mock Services

```bash
# Start mock services
docker-compose -f docker-compose.yml -f docker-compose.trust-tests.yml up -d

# Run all trust tests
npx playwright test specs/api/discover-and-trust.spec.ts

# Stop services
docker-compose -f docker-compose.yml -f docker-compose.trust-tests.yml down
```

### With Test Authentication

Some tests require an authenticated user. Set the `TEST_AUTH_TOKEN` environment
variable with a valid JWT:

```bash
TEST_AUTH_TOKEN=<jwt-token> npx playwright test specs/api/discover-and-trust.spec.ts
```

## Mock Services

### Mock Issuer (Port 9000)

Simulates an OpenID4VCI credential issuer with:
- `/.well-known/openid-credential-issuer` - Issuer metadata
- `/.well-known/oauth-authorization-server` - OAuth metadata
- `/mdoc_iacas` - IACA certificates for mDL/PID

### Mock Verifier (Port 9001)

Simulates an OpenID4VP verifier with:
- `/.well-known/openid4vp-verifier` - Verifier metadata
- `/presentation_request` - Create presentation requests

### Mock Trust PDP (Port 9090)

Simulates an AuthZEN policy decision point (go-trust) with:
- `/.well-known/authzen-configuration` - AuthZEN discovery
- `/access/v1/evaluation` - Access evaluation endpoint
- `/policies` - Debug endpoint to view configured policies

Configure trusted entities via environment variables:
- `TRUSTED_ISSUERS` - Comma-separated trusted issuer URLs
- `TRUSTED_VERIFIERS` - Comma-separated trusted verifier URLs

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKEND_URL` | Wallet backend URL | `http://localhost:8080` |
| `MOCK_ISSUER_URL` | Mock issuer URL | `http://localhost:9000` |
| `MOCK_VERIFIER_URL` | Mock verifier URL | `http://localhost:9001` |
| `TRUST_PDP_URL` | Trust PDP URL | `http://localhost:9090` |
| `TEST_AUTH_TOKEN` | JWT for authenticated tests | (none) |
| `TRUSTED_ISSUER_URL` | Known trusted issuer for tests | (none) |
| `TRUSTED_VERIFIER_URL` | Known trusted verifier for tests | (none) |

## API Version Detection

The tests verify that the backend properly advertises its API version:

1. Frontend fetches `/status` endpoint
2. Response includes `api_version` field (integer)
3. API version 2+ indicates discover-and-trust support
4. Frontend gracefully degrades to legacy behavior for version 1

## Test Coverage

1. **API Version Discovery**
   - Status endpoint returns api_version
   - Version 2+ enables discover-and-trust
   - Feature detection works correctly

2. **Authentication**
   - Endpoint requires valid JWT
   - Returns 401 for unauthenticated requests

3. **Input Validation**
   - Rejects missing entity_identifier
   - Rejects missing role
   - Rejects invalid role values

4. **Response Structure**
   - Issuer discovery response format
   - Verifier discovery response format
   - Trust evaluation result fields

5. **Mock Service Integration**
   - Discovers mock issuer metadata
   - Evaluates trust for mock issuer
   - Returns IACA certificates when available

6. **PDP Integration**
   - AuthZEN discovery works
   - Trusted entities return trusted=true
   - Untrusted entities return trusted=false

7. **Backwards Compatibility**
   - Legacy endpoints still work
   - Status endpoint is additive
