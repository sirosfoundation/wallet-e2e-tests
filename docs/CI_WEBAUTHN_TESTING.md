# CI/CD WebAuthn Testing Guide

## Overview

This guide documents the two-track approach for WebAuthn testing with PRF extension support:

| Track | Approach | PRF Support | CI/CD Compatible | Use Case |
|-------|----------|-------------|------------------|----------|
| **CDP Track** | Chrome DevTools Protocol + PRF mock | ✅ Via JS injection | ✅ Fully headless | CI/CD pipelines |
| **soft-fido2 Track** | UHID virtual authenticator | ✅ Native | ❌ Requires display | Local development |

## The PRF Requirement

The wallet uses WebAuthn's PRF (Pseudo-Random Function) extension for key derivation. Without PRF support, the wallet cannot derive the symmetric keys needed for secure credential storage.

```
User Master Secret → PRF(salt) → Derived Key → Credential Encryption
```

This makes PRF testing **mandatory** for meaningful WebAuthn tests.

## CDP Track (CI-Compatible)

### How It Works

1. **Chrome's CDP Virtual Authenticator**: Playwright uses Chrome DevTools Protocol to create a virtual authenticator that handles credential creation/assertion.

2. **PRF Bug in CDP**: Chrome's virtual authenticator reports `hasPrf=true` but returns empty PRF results (known bug).

3. **PRF Mock Injection**: We inject JavaScript that patches `navigator.credentials.create/get` to compute actual HMAC-SHA256 PRF outputs.

```typescript
// The PRF mock computes real cryptographic values:
const computePrfOutput = async (seed, salt) => {
  const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, salt);
};
```

### Usage

```bash
# Run CDP WebAuthn tests (headless, CI-compatible)
make test-webauthn-cdp-ci

# Or directly with Playwright
npx playwright test --config=playwright.webauthn-ci.config.ts
```

### Files

- `specs/webauthn-ci/` - CDP-based test specs
- `playwright.webauthn-ci.config.ts` - CI configuration
- `helpers/webauthn.ts` - CDP helper with PRF mock injection

### Trade-offs

| Pros | Cons |
|------|------|
| Works in any CI/CD environment | PRF is mocked at JavaScript level |
| No special OS requirements | Less "real" than hardware authenticator |
| Fast and reliable | Cannot test low-level authenticator behavior |
| Fully headless | |

## soft-fido2 Track (Comprehensive)

### How It Works

1. **UHID Kernel Module**: soft-fido2 creates a virtual USB HID device that the OS recognizes as a real FIDO2 authenticator.

2. **Native WebAuthn**: Browser uses actual WebAuthn API calls that go through the OS stack to the virtual authenticator.

3. **Real PRF**: soft-fido2 implements PRF extension natively, providing actual cryptographic outputs.

### Requirements

- Linux with UHID kernel module
- udev rules for UHID device access
- Headed browser (Xvfb for CI)
- soft-fido2 binary

### Usage

```bash
# Local development (with display)
SOFT_FIDO2_PATH=../soft-fido2 make up
make test-webauthn

# CI with Xvfb
make test-webauthn-xvfb
```

### Files

- `specs/real-webauthn/` - soft-fido2 test specs
- `playwright.real-webauthn.config.ts` - Real WebAuthn configuration
- `helpers/real-webauthn.ts` - soft-fido2 helper
- `scripts/start-soft-fido2.sh` - Authenticator startup script

### Trade-offs

| Pros | Cons |
|------|------|
| Tests complete OS stack | Requires Linux + kernel module |
| Native PRF implementation | Needs display server |
| Most realistic testing | Complex setup |
| Good for integration testing | Slower than CDP |

## CI/CD Integration

### GitHub Actions

The workflow `.github/workflows/e2e-tests.yml` runs both API and CDP WebAuthn tests:

```yaml
jobs:
  webauthn-ci-tests:
    runs-on: ubuntu-latest
    steps:
      - name: Run WebAuthn CI tests
        run: npx playwright test --config=playwright.webauthn-ci.config.ts
```

### Docker Environment

All tests use Docker Compose for consistent service deployment:

```bash
# Start services
docker compose -f docker-compose.test.yml up -d

# Run CDP tests (headless)
make test-webauthn-cdp-ci

# Run soft-fido2 tests (requires Xvfb)
make test-webauthn-xvfb
```

## Test Coverage Strategy

### CDP Track Tests (`specs/webauthn-ci/`)

Focus on:
- User registration flow with PRF
- Login flow with PRF
- PRF output verification
- Error handling

### soft-fido2 Track Tests (`specs/real-webauthn/`)

Focus on:
- Complete credential lifecycle
- Multi-tenant WebAuthn
- Cross-origin scenarios
- Credential management

### API Tests (`specs/api/`)

No WebAuthn - test backend APIs directly:
- Tenant management
- Credential issuance
- Verification flows
- Registry operations

## Extending Tests

### Adding CDP Tests

1. Create test in `specs/webauthn-ci/`
2. Use the `webauthnTest` fixture:

```typescript
import { WebAuthnHelper } from '../../helpers/webauthn';

const webauthnTest = test.extend({
  webauthn: async ({ page }, use) => {
    const webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
    await use(webauthn);
    await webauthn.cleanup();
  },
});

webauthnTest('my test', async ({ page, webauthn }) => {
  // Test with PRF-enabled virtual authenticator
});
```

### Adding soft-fido2 Tests

1. Create test in `specs/real-webauthn/`
2. Use real browser WebAuthn API (soft-fido2 handles it automatically)
3. Ensure test runs with `playwright.real-webauthn.config.ts`

## Troubleshooting

### CDP Tests

**PRF mock not working:**
- Ensure `injectPrfMock()` is called BEFORE page navigation
- Check console for `[PRF Mock]` log messages

**Credentials not persisting:**
- CDP credentials don't persist across navigations by default
- For login tests, use same browser context

### soft-fido2 Tests

**Authenticator not detected:**
- Check UHID module: `lsmod | grep uhid`
- Verify udev rules installed
- Check soft-fido2 logs: `tail -f /tmp/soft-fido2.log`

**Tests timeout:**
- Ensure `headless: false` in config
- Browser must show WebAuthn UI for soft-fido2 to respond

## References

- [WebAuthn PRF Extension](https://w3c.github.io/webauthn/#prf-extension)
- [Chrome CDP WebAuthn](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/)
- [soft-fido2](../soft-fido2/README.md)
- [Playwright WebAuthn Testing](https://playwright.dev/docs/auth#webauthn)
