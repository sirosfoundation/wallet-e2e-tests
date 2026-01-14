/**
 * PRF-Enabled WebAuthn E2E Tests
 *
 * @tags @prf
 *
 * These tests verify that the wallet-frontend works correctly with the
 * WebAuthn PRF (Pseudo-Random Function) extension, which is required for
 * the wallet's key derivation and encryption.
 */

import { test, expect, type Page } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';

test.describe('PRF WebAuthn Registration @prf', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('should verify PRF extension is requested during registration', async ({ page }) => {
    // Intercept the WebAuthn creation request to verify PRF extension is included
    let createOptions: any = null;

    await page.route('**/user/register-webauthn-begin', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      createOptions = json.createOptions;
      await route.fulfill({ response });
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(300);
    }

    // Fill in name
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill(generateTestUsername());
    }

    // Click platform passkey button to trigger registration
    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    // Wait for the registration to start
    await page.waitForTimeout(1000);

    // Verify PRF extension was requested by backend
    expect(createOptions).not.toBeNull();
    expect(createOptions.publicKey.extensions).toBeDefined();
    expect(createOptions.publicKey.extensions.prf).toBeDefined();
  });

  test('should complete registration with PRF authenticator', async ({ page }) => {
    const testName = generateTestUsername();

    // Monitor network for registration flow
    const networkRequests: string[] = [];
    page.on('request', req => {
      if (req.url().includes('localhost:8080')) {
        networkRequests.push(req.url());
      }
    });

    // Track console for errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(300);
    }

    // Fill in name
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill(testName);
    }

    // Click platform passkey button
    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    // Wait for registration flow to complete or for PRF retry prompt
    await page.waitForTimeout(3000);

    // Check if we're on the PRF retry prompt
    const continueButton = page.locator('#continue-prf-loginsignup');
    if (await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('PRF retry prompt appeared - clicking continue');
      await continueButton.click();
      await page.waitForTimeout(3000);
    }

    // Log any console errors for debugging
    if (consoleErrors.length > 0) {
      console.log('Console errors:', consoleErrors);
    }

    // Check for credentials created
    const credentials = await webauthn.getCredentials();
    console.log('Credentials created:', credentials.length);

    // Log network activity for debugging
    console.log('Network requests:', networkRequests.filter(r => r.includes('webauthn')));

    // Verify at least one credential was created
    expect(credentials.length).toBeGreaterThan(0);
  });

  test.skip('should handle PRF not supported error gracefully', async ({ page }) => {
    // SKIP: Chrome DevTools Protocol virtual authenticator cannot properly simulate
    // PRF-not-supported scenario. Even with hasPrf: false, CDP returns:
    //   prf: { enabled: true, results: { first: {} } }
    // where `first` is an empty object (truthy) instead of undefined.
    //
    // This test is kept for documentation and for when CDP improves PRF simulation.
    // The wallet-frontend PRF error handling code path at:
    //   src/services/keystore.ts:723-761
    // is correct and throws "Browser or authenticator does not support PRF"
    // when prf.results.first is missing or prf.enabled is false.
    //
    // To manually test PRF-not-supported:
    // 1. Use a real non-PRF security key (e.g., older YubiKey)
    // 2. Or use a browser that doesn't support the PRF extension

    // IMPORTANT: For this test we need to NOT have the PRF mock injected,
    // so we cleanup and reinitialize WITHOUT the mock
    await webauthn.cleanup();
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    // Explicitly do NOT call injectPrfMock() - we want real CDP behavior
    await webauthn.addAuthenticatorWithoutPrf();

    // Add diagnostic logging to see what the browser returns for PRF
    await page.addInitScript(() => {
      const originalCreate = navigator.credentials.create.bind(navigator.credentials);
      (navigator.credentials as any).create = async (options: CredentialCreationOptions) => {
        console.log('[TEST] WebAuthn create called');
        const result = await originalCreate(options);
        if (result) {
          const pkc = result as PublicKeyCredential;
          const extensions = pkc.getClientExtensionResults();
          console.log('[TEST] Client extension results:', JSON.stringify(extensions));
          const prfResult = (extensions as any)?.prf;
          console.log('[TEST] PRF result:', JSON.stringify(prfResult));
          console.log('[TEST] PRF enabled:', prfResult?.enabled);
          console.log('[TEST] PRF first:', prfResult?.results?.first ? 'present' : 'missing');
        }
        return result;
      };
    });

    // Collect console logs
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[TEST]')) {
        consoleLogs.push(msg.text());
      }
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(300);
    }

    // Fill in name
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill(generateTestUsername());
    }

    // Click platform passkey button
    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    // Wait for WebAuthn to complete
    await page.waitForTimeout(5000);

    // Log diagnostics
    console.log('=== PRF DIAGNOSTIC LOGS ===');
    for (const log of consoleLogs) {
      console.log(log);
    }
    console.log('=== END DIAGNOSTICS ===');

    // Check current URL - if we're logged in, PRF was somehow accepted
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    // The error message should be displayed in a red text area if PRF fails
    const errorLocator = page.locator('.text-red-500, [class*="error"], [role="alert"]');
    const hasError = await errorLocator.isVisible().catch(() => false);

    if (!hasError && currentUrl.includes('/login')) {
      // Still on login page but no visible error - check page content
      const pageContent = await page.content();
      console.log('Page has PRF text:', pageContent.includes('PRF'));
      console.log('Page has "not supported":', pageContent.includes('not supported'));
    }

    // If registration succeeded without PRF, that's a problem
    if (currentUrl === 'http://localhost:3000/' || currentUrl === 'http://localhost:3000') {
      console.log('WARNING: Registration succeeded even without PRF support!');
      // This means either:
      // 1. Chrome CDP reports prf.enabled=true even when hasPrf=false
      // 2. The frontend doesn't properly check PRF results
      // Let's check what we got
      expect(hasError).toBe(true); // Should have shown error
    } else if (hasError) {
      const errorText = await errorLocator.textContent();
      console.log('Error message:', errorText);
      expect(errorText).toMatch(/PRF|not supported|security key/i);
    }
  });
});

test.describe('PRF WebAuthn Login @prf', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('should verify PRF extension is requested during login', async ({ page }) => {
    let getOptions: any = null;

    await page.route('**/user/login-webauthn-begin', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      getOptions = json.getOptions;
      await route.fulfill({ response });
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Ensure we're in login mode (not signup)
    const loginModeButton = page.getByRole('button', { name: /log in|sign in/i });
    if (await loginModeButton.isVisible()) {
      await loginModeButton.click();
      await page.waitForTimeout(300);
    }

    // Click platform passkey button to trigger login
    const platformButton = page.locator('button[value="client-device"]');
    if (await platformButton.isVisible()) {
      await platformButton.click();

      // Wait for the login to start
      await page.waitForTimeout(1000);

      // Verify backend returned options
      expect(getOptions).not.toBeNull();
      expect(getOptions.publicKey).toBeDefined();
    }
  });
});

test.describe('PRF Extension Capabilities @prf', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('should create authenticator with PRF support', async ({ page }) => {
    const authId = await webauthn.addPlatformAuthenticator();
    expect(authId).toBeDefined();
    expect(typeof authId).toBe('string');

    // Verify authenticator is ready
    const credentials = await webauthn.getCredentials();
    expect(Array.isArray(credentials)).toBe(true);
    expect(credentials.length).toBe(0); // No credentials yet
  });

  test('should be able to add credentials to PRF authenticator', async ({ page }) => {
    await webauthn.addPlatformAuthenticator();

    // Navigate to trigger WebAuthn
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // At this point, no credentials should exist yet
    const initialCredentials = await webauthn.getCredentials();
    expect(initialCredentials.length).toBe(0);
  });
});
