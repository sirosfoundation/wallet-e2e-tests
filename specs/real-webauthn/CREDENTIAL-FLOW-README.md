# Credential Flow E2E Tests

This directory contains end-to-end tests for the complete credential lifecycle:
1. **Issuance**: Obtaining credentials via OpenID4VCI
2. **Verification**: Presenting credentials via OpenID4VP

## Architecture

### Mock Services

The tests use mock issuer and verifier services that implement the full OID4VCI and OID4VP protocols:

- **Full Flow Issuer** (`mocks/issuer/full-flow-issuer.ts`): A complete OID4VCI credential issuer supporting:
  - Metadata endpoints (`.well-known/openid-credential-issuer`, `.well-known/oauth-authorization-server`)
  - PAR (Pushed Authorization Request) endpoint
  - Authorization endpoint
  - Token endpoint (supports `authorization_code` and `urn:ietf:params:oauth:grant-type:pre-authorized_code`)
  - Credential endpoint (issues SD-JWT credentials)
  - `/offer` endpoint for generating pre-authorized credential offers
  - `/jwks` endpoint for issuer public keys

- **Full Flow Verifier** (`mocks/verifier/full-flow-verifier.ts`): A complete OID4VP verifier supporting:
  - Verifier metadata endpoint
  - `/create-request` to initiate verification
  - `/request/:id` to serve authorization request objects with DCQL queries
  - `/response/:id` for direct_post VP response handling
  - `/status/:id` to check verification status

### Test File

- **`credential-flow.spec.ts`**: Main test file with:
  - User registration and login via WebAuthn
  - Credential issuance via pre-authorized code flow
  - Credential presentation via direct_post response mode
  - Error handling tests

## Prerequisites

1. **soft-fido2 Virtual Authenticator**: Required for WebAuthn operations without physical hardware
   ```bash
   export SOFT_FIDO2_PATH=/path/to/soft-fido2
   ```

2. **Docker Services**: Wallet frontend and backend must be running
   ```bash
   cd wallet-e2e-tests
   make up
   ```

## Running Tests

### Start Mock Services

In separate terminals:

```bash
# Terminal 1: Start mock issuer (port 9000)
npm run mock:issuer

# Terminal 2: Start mock verifier (port 9001)
npm run mock:verifier
```

Or run them in the background:
```bash
npm run mock:issuer &
npm run mock:verifier &
```

### Run Credential Flow Tests

```bash
# Run all credential flow tests
npm run test:credential-flow

# Run with debug mode
npm run test:credential-flow:debug
```

### Run All Real WebAuthn Tests (including credential flow)

```bash
npm run test:real-webauthn
```

## Test Flow

1. **Setup**: Mock issuer and verifier start and generate ephemeral keys
2. **User Registration**: New user registers with WebAuthn (soft-fido2 authenticator)
3. **Credential Issuance**:
   - Test requests a credential offer from mock issuer
   - Wallet navigates to offer URL
   - Wallet exchanges pre-authorized code for access token
   - Wallet requests and stores SD-JWT credential
4. **Credential Presentation**:
   - Test creates verification request at mock verifier
   - Wallet navigates to verification URL
   - Wallet matches credential to DCQL query
   - User consents and wallet sends VP response
   - Verifier validates presentation

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_URL` | `http://localhost:3000` | Wallet frontend URL |
| `BACKEND_URL` | `http://localhost:8080` | Wallet backend URL |
| `ADMIN_URL` | `http://localhost:8081` | Admin API URL |
| `ISSUER_URL` | `http://localhost:9000` | Mock issuer URL |
| `VERIFIER_URL` | `http://localhost:9001` | Mock verifier URL |
| `SOFT_FIDO2_PATH` | - | Path to soft-fido2 binary |

## Debugging

### View Issuer/Verifier Logs

Both mock services log all requests to stdout.

### Mock Issuer Demo

Visit `http://localhost:9000/` for a demo page that generates credential offers.

### Mock Verifier Demo

Visit `http://localhost:9001/demo` for a demo page that creates verification requests.

### Check Request Status

```bash
# Check issuer health
curl http://localhost:9000/health

# Check verifier health
curl http://localhost:9001/health

# Check verification status
curl http://localhost:9001/status/{request_id}
```

## Extending Tests

### Adding New Credential Types

1. Update `getCredentialIssuerMetadata()` in `full-flow-issuer.ts` to add new credential configurations
2. Update `createSDJWTCredential()` to generate the appropriate claims
3. Update `createDCQLQuery()` in `full-flow-verifier.ts` to request the new credential type

### Adding Authorization Code Flow Tests

The mock issuer supports the full authorization code flow. To test:
1. Navigate to the issuer's authorization endpoint
2. Handle user authentication (currently auto-approves)
3. Exchange authorization code for tokens

See the skipped test in `credential-flow.spec.ts` for guidance.
