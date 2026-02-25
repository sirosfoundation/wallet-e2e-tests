# VC Services Integration for E2E Testing

This document describes the integration of production-ready VC issuer and verifier services from the [SUNET/vc](https://github.com/SUNET/vc) project into the wallet E2E test environment.

## Motivation

The current E2E tests use mock issuer and verifier services (`mocks/issuer/` and `mocks/verifier/`) that are simple Node.js implementations. While useful for basic flow testing, they don't exercise:

- Real SD-JWT/mDOC credential generation with proper signing
- VCTM (Verifiable Credential Type Metadata) validation
- Credential status lists and revocation
- Full OpenID4VP DCQL query processing
- Production-grade error handling and edge cases

By integrating the production VC services, we get comprehensive end-to-end testing with real credential formats.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Compose Test Environment               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │   wallet-    │   │   wallet-    │   │   vctm-registry      │ │
│  │   frontend   │   │   backend    │   │   (go-wallet-backend)│ │
│  │   :3000      │   │   :8080/8082 │   │   :8097              │ │
│  └──────────────┘   └──────────────┘   └──────────────────────┘ │
│         │                  │                      │              │
│         └──────────────────┼──────────────────────┘              │
│                            │                                     │
│  ┌─────────────────────────┼─────────────────────────────────┐  │
│  │                    VC Services                              │ │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐ │  │
│  │  │  vc-     │   │  vc-     │   │  vc-     │   │ mongodb │ │  │
│  │  │  issuer  │   │  verifier│   │  mockas  │   │  :27017 │ │  │
│  │  │  :9000   │   │  :9001   │   │  :9002   │   │         │ │  │
│  │  └──────────┘   └──────────┘   └──────────┘   └─────────┘ │  │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐                                               │
│  │ mock-trust-  │  (existing - for go-trust integration)        │
│  │ pdp :9091    │                                               │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Service Roles

| Service | Port | Description |
|---------|------|-------------|
| vc-issuer | 9000 | OpenID4VCI credential issuer (SD-JWT, mDOC) |
| vc-verifier | 9001 | OpenID4VP verifier with OIDC Provider |
| vc-mockas | 9002 | Mock Authentication Server (simulates AS) |
| mongodb | 27017 | Persistent storage for VC services |
| mock-trust-pdp | 9091 | Existing AuthZEN trust PDP |

## Implementation Phases

### Phase 1: Docker Compose Configuration ✅

Create `docker-compose.vc-services.yml` with:
- MongoDB container
- VC issuer service
- VC verifier service  
- VC mockas service
- Shared network configuration

Create `fixtures/vc-config.yaml`:
- E2E-specific configuration
- Localhost URLs for all services
- Test-mode settings (auto-approve, relaxed validation)

### Phase 2: PKI and Test Data

Create `fixtures/vc-pki/`:
- EC P-256 signing keys for issuer
- EC P-256 signing keys for verifier
- Self-signed certificate chain

Create `fixtures/vc-metadata/`:
- Copy VCTM files from vc project
- `vctm_pid_arf_1_8.json` (PID credential)
- `vctm_ehic.json` (health insurance)
- Additional credential types as needed

Create `fixtures/vc-users/`:
- Test user data files for mockas
- Pre-defined attributes for credential issuance

### Phase 3: Integration Modes

Update `Makefile` with new targets:
```makefile
# Default: mock services (fast, simple)
test: test-mock

# Mock services only
test-mock: up-mock run-tests down-mock

# VC production services
test-vc: up-vc run-tests down-vc

# Both modes
test-all: test-mock test-vc
```

Create test profiles:
- `ISSUER_TYPE=mock|vc` environment variable
- `VERIFIER_TYPE=mock|vc` environment variable

### Phase 4: Test Specifications

Create `specs/vc-services/`:
- `issuance-sdjwt.spec.ts` - SD-JWT credential issuance
- `issuance-mdoc.spec.ts` - mDOC credential issuance  
- `verification-dcql.spec.ts` - DCQL-based presentation
- `revocation.spec.ts` - Credential status list testing

Create `helpers/vc-services.ts`:
- `createCredentialOfferVC()` - Generate offers via VC issuer
- `createVerificationSessionVC()` - Create verification sessions
- `checkCredentialStatus()` - Query status lists
- `getIssuerMetadata()` - Fetch issuer configuration

### Phase 5: CI Integration

Update `.github/workflows/`:
- Add job matrix for mock vs vc-services
- Cache VC service Docker images
- Separate test result artifacts per mode

## Configuration Details

### VC Issuer Configuration

```yaml
issuer:
  issuer_url: "http://localhost:9000"
  api_server:
    addr: :9000
  key_config:
    private_key_path: "/pki/signing_ec_private.pem"
    chain_path: "/pki/signing_ec_chain.pem"
  jwt_attribute:
    issuer: "http://localhost:9000"
    enable_not_before: true
    valid_duration: 3600

credential_constructor:
  pid:
    vctm_file_path: "/metadata/vctm_pid_arf_1_8.json"
    auth_method: basic
    format: "dc+sd-jwt"
```

### VC Verifier Configuration

```yaml
verifier:
  api_server:
    addr: :9001
  public_url: "http://localhost:9001"
  key_config:
    private_key_path: "/pki/verifier_ec_private.pem"
    chain_path: "/pki/verifier_ec_chain.pem"
  openid4vp:
    presentation_timeout: 300
    supported_credentials:
      - vct: "urn:eudi:pid:arf-1.8:1"
        scopes: ["profile", "pid"]
```

### MockAS Configuration

```yaml
mock_as:
  api_server:
    addr: :9002
  # Auto-approve all authentication requests
  auto_approve: true
  # Return test user data
  test_users_path: "/users/test_users.json"
```

## Test Data

### Test Users (fixtures/vc-users/test_users.json)

```json
{
  "users": [
    {
      "id": "test-user-001",
      "given_name": "Alice",
      "family_name": "Wonderland",
      "birthdate": "1990-01-15",
      "email": "alice@example.com",
      "nationality": "SE"
    },
    {
      "id": "test-user-002", 
      "given_name": "Bob",
      "family_name": "Builder",
      "birthdate": "1985-06-20",
      "email": "bob@example.com",
      "nationality": "DE"
    }
  ]
}
```

## Usage

### Running with Mock Services (Default)

```bash
# Fast tests with simple mocks
make test
# or explicitly
make test-mock
```

### Running with VC Services

```bash
# Comprehensive tests with production services
make test-vc
```

### Running Both

```bash
# Full test suite
make test-all
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ISSUER_TYPE` | `mock` | `mock` or `vc` |
| `VERIFIER_TYPE` | `mock` | `mock` or `vc` |
| `VC_ISSUER_URL` | `http://localhost:9000` | VC issuer URL |
| `VC_VERIFIER_URL` | `http://localhost:9001` | VC verifier URL |
| `VC_MOCKAS_URL` | `http://localhost:9002` | MockAS URL |

## Benefits

1. **Production-ready testing**: Real SD-JWT and mDOC credentials
2. **Standards compliance**: Full OID4VCI/OID4VP implementation
3. **Revocation testing**: Status list integration
4. **VCTM validation**: Schema validation during issuance
5. **Trust chain testing**: Real certificate validation
6. **Format coverage**: Test multiple credential formats

## Future Enhancements

- [ ] Add mdoc IACA certificate testing
- [ ] Add batch credential issuance tests
- [ ] Add deferred credential flow tests
- [ ] Add credential refresh/update tests
- [ ] Add cross-device verification flow tests
