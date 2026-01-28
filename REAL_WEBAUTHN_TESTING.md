# Real WebAuthn Testing Architecture

## Problem Statement

The current E2E tests use Chrome DevTools Protocol (CDP) virtual authenticators, which have critical limitations:

1. **PRF Extension Bug**: CDP virtual authenticators report `hasPrf=true` but return empty PRF results, requiring JavaScript mocking
2. **No Real Browser Stack**: Tests don't exercise the actual browser → platform authenticator → OS interaction
3. **No OS Dialogs**: Real users see biometric prompts, passkey pickers, etc. that are completely bypassed
4. **Credential Storage**: Virtual credentials don't persist like real passkeys do
5. **Edge Cases Missed**: The bugs we fixed (userHandle extraction, discoverable login flow) weren't caught by mocked tests

## Proposed Solution: Hybrid Testing Architecture

We propose a **three-tier testing strategy**:

### Tier 1: Unit Tests (Fast, In-Process)
- Pure JavaScript/TypeScript unit tests for WebAuthn client logic
- Use `virtualwebauthn` Go library patterns for mocking server-side
- Run in CI on every commit

### Tier 2: Real Browser Integration Tests (Headed Mode)
- Run Playwright in headed mode with software authenticator
- Uses Chrome's `--enable-features=WebAuthenticationMacPlatformAuthenticator` on macOS
- Uses Windows Hello software mode on Windows
- Tests real WebAuthn browser stack without hardware
- Run in CI with display server (Xvfb on Linux)

### Tier 3: Manual/Hardware Testing
- Real passkey devices (YubiKey, security keys)
- Real platform authenticators (Touch ID, Windows Hello, Android)
- Exploratory testing before releases

---

## Tier 2 Implementation: Software Platform Authenticator

### Approach: Chrome Software Authenticator Mode

Chrome has built-in support for software platform authenticators that don't require biometrics:

```bash
# macOS - Enable software authenticator (no Touch ID required)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --enable-features=WebAuthenticationMacPlatformAuthenticator

# Or use Chrome's virtual authenticator UI feature for testing
# This creates a REAL software authenticator that appears to the browser
# as a platform authenticator
```

### Playwright Configuration for Headed Mode

```typescript
// playwright.real-webauthn.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs/real-webauthn',
  fullyParallel: false, // Serial execution for WebAuthn state consistency
  workers: 1,
  
  use: {
    headless: false, // CRITICAL: Must run headed for real WebAuthn
    launchOptions: {
      args: [
        // Enable Chrome's software authenticator
        '--enable-features=WebAuthenticationCable',
        // Allow insecure localhost for development
        '--ignore-certificate-errors',
      ],
    },
    video: 'on-first-retry',
    trace: 'on-first-retry',
  },
  
  projects: [
    {
      name: 'real-webauthn-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

### Test Helper for Real WebAuthn

```typescript
// helpers/real-webauthn.ts
import { Page, BrowserContext } from '@playwright/test';

export interface RealWebAuthnOptions {
  /**
   * Whether to use Chrome's built-in software authenticator
   * instead of the CDP virtual authenticator
   */
  useSoftwareAuthenticator: boolean;
  
  /**
   * Timeout for user verification prompts
   * Real authenticators show UI that needs time
   */
  userVerificationTimeout: number;
}

export class RealWebAuthnHelper {
  private page: Page;
  private context: BrowserContext;
  
  constructor(page: Page) {
    this.page = page;
    this.context = page.context();
  }
  
  /**
   * Wait for and handle the passkey prompt.
   * In headed mode with software authenticator, this may show a UI dialog.
   */
  async waitForPasskeyPrompt(timeout = 30000): Promise<void> {
    // The browser will show a native passkey dialog
    // For software authenticator, it auto-approves after a brief delay
    // For real testing, we may need to interact with the dialog
    
    // Wait for the WebAuthn operation to complete or timeout
    await this.page.waitForFunction(
      () => {
        const pendingOp = (window as any).__webauthn_pending__;
        return pendingOp === undefined || pendingOp === null;
      },
      { timeout }
    );
  }
  
  /**
   * Register tracking for WebAuthn operations.
   * Injects minimal tracking code to know when operations start/complete.
   */
  async trackWebAuthnOperations(): Promise<void> {
    await this.page.addInitScript(() => {
      const originalCreate = navigator.credentials.create.bind(navigator.credentials);
      const originalGet = navigator.credentials.get.bind(navigator.credentials);
      
      navigator.credentials.create = async (options) => {
        (window as any).__webauthn_pending__ = 'create';
        (window as any).__webauthn_start__ = Date.now();
        try {
          const result = await originalCreate(options);
          (window as any).__webauthn_pending__ = null;
          return result;
        } catch (e) {
          (window as any).__webauthn_pending__ = null;
          throw e;
        }
      };
      
      navigator.credentials.get = async (options) => {
        (window as any).__webauthn_pending__ = 'get';
        (window as any).__webauthn_start__ = Date.now();
        try {
          const result = await originalGet(options);
          (window as any).__webauthn_pending__ = null;
          return result;
        } catch (e) {
          (window as any).__webauthn_pending__ = null;
          throw e;
        }
      };
    });
  }
}
```

---

## Alternative: Puppeteer with Authenticator API

Puppeteer provides a higher-level authenticator API that might work better:

```typescript
// Using Puppeteer instead of Playwright for WebAuthn
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: false,
  args: ['--enable-features=WebAuthenticationCable'],
});

const page = await browser.newPage();
const client = await page.target().createCDPSession();

// This creates a virtual authenticator, but with full PRF support
await client.send('WebAuthn.enable');
const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
    // PRF support - note: may still have issues
    extensions: ['prf', 'largeBlob', 'credBlob'],
  },
});
```

---

## Recommended Implementation Plan

### Phase 1: Create Separate Real WebAuthn Test Suite (Week 1)

1. Create new config `playwright.real-webauthn.config.ts`
2. Create new test directory `specs/real-webauthn/`
3. Create `RealWebAuthnHelper` class
4. Port `critical-path.spec.ts` to real WebAuthn tests
5. Add npm script: `test:real-webauthn`

### Phase 2: CI Integration with Xvfb (Week 2)

1. Set up GitHub Actions workflow with Xvfb for headed browser
2. Add caching for Chromium installation
3. Run real WebAuthn tests as part of CI (separate job)
4. Configure timeout and retry strategies

### Phase 3: PRF-Specific Tests (Week 3)

1. Create tests that specifically exercise PRF extension
2. Verify key derivation works correctly
3. Test PRF output consistency across login flows
4. Test PRF with different credential types

### Phase 4: Multi-Tenant Tests (Week 4)

1. Create comprehensive multi-tenant test suite
2. Test userHandle extraction from different login paths
3. Test tenant switching scenarios
4. Test edge cases that CDP mocking missed

---

## File Structure

```
wallet-e2e-tests/
├── playwright.config.ts              # Existing CDP-based config
├── playwright.real-webauthn.config.ts # New real WebAuthn config
├── helpers/
│   ├── webauthn.ts                   # Existing CDP helper
│   └── real-webauthn.ts              # New real WebAuthn helper
├── specs/
│   ├── multi-tenancy/                # Existing CDP-based tests
│   └── real-webauthn/                # New real WebAuthn tests
│       ├── passkey-registration.spec.ts
│       ├── passkey-login.spec.ts
│       ├── prf-extension.spec.ts
│       └── multi-tenant-login.spec.ts
├── package.json
└── REAL_WEBAUTHN_TESTING.md          # This document
```

---

## NPM Scripts

```json
{
  "scripts": {
    "test": "playwright test --config=playwright.config.ts",
    "test:real-webauthn": "playwright test --config=playwright.real-webauthn.config.ts",
    "test:all": "npm run test && npm run test:real-webauthn"
  }
}
```

---

## Known Limitations

### PRF in CDP Virtual Authenticators
- Chrome's CDP virtual authenticator returns empty PRF results
- Current workaround: JavaScript injection to mock PRF
- Real browser software authenticator should work correctly

### Headed Browser in CI
- Requires Xvfb or similar display server
- Slower than headless tests
- May have flakiness due to UI timing

### Cross-Browser Support
- Safari has limited automation for passkeys
- Firefox WebAuthn CDP support differs from Chrome
- Initial focus on Chrome/Chromium only

### Platform-Specific Behavior
- macOS: Software authenticator available via feature flag
- Windows: Windows Hello software mode
- Linux: May require additional configuration

---

## Success Criteria

The new test framework should:

1. ✅ Catch bugs like the `userHandle` extraction issue we fixed
2. ✅ Test real PRF extension functionality
3. ✅ Exercise the full browser WebAuthn stack
4. ✅ Run in CI without manual intervention
5. ✅ Provide clear failure diagnostics
6. ✅ Be maintainable alongside existing tests

---

## References

- [WebAuthn.io](https://webauthn.io/) - Demo and testing site
- [passkeys.dev](https://passkeys.dev/) - Passkey implementation guide
- [Chrome DevTools WebAuthn](https://developer.chrome.com/docs/devtools/webauthn) - CDP documentation
- [Playwright Authentication](https://playwright.dev/docs/auth) - Playwright auth patterns
- [virtualwebauthn](../virtualwebauthn/) - Go library for server-side testing
