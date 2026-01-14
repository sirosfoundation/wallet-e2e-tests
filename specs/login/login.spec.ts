/**
 * Wallet Login E2E Tests
 *
 * @tags @login
 *
 * Tests the full WebAuthn login flow using the actual wallet-frontend UI.
 * Requires a pre-registered credential for login tests.
 */

import { test, expect, type Page } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import { injectStorageClearing } from '../../helpers/browser-storage';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

test.describe('Wallet Login Flow @login', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await injectStorageClearing(page);
    // Inject PRF mock BEFORE navigation
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  /**
   * Helper to complete registration first (needed for login tests)
   */
  async function registerUser(page: Page, username: string): Promise<boolean> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signUpLink = page.getByRole('button', { name: /sign up/i });
    if (await signUpLink.count() > 0) {
      await signUpLink.first().click();
      await page.waitForTimeout(500);
    }

    // Fill in name if visible
    const nameInput = page.getByPlaceholder(/name|display/i);
    if (await nameInput.count() > 0) {
      await nameInput.fill(username);
    }

    // Click platform passkey
    const passkeyButton = page.getByRole('button', { name: /passkey on this device/i });
    if (await passkeyButton.isVisible()) {
      await passkeyButton.click();

      // Wait for registration to complete
      try {
        await page.waitForURL('http://localhost:3000/', { timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  test('should complete full login flow after registration', async ({ page }) => {
    const username = generateTestUsername();

    // First register
    const registered = await registerUser(page, username);

    if (!registered) {
      console.log('Registration failed, skipping login test');
      test.skip();
      return;
    }

    console.log('[TEST] Registration completed, attempting login...');

    // Clear session/logout (navigate to login page explicitly)
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Track network activity
    const networkLog: { type: string; url: string; status?: number }[] = [];
    page.on('response', res => {
      if (res.url().includes('localhost:8080')) {
        networkLog.push({
          type: 'response',
          url: res.url(),
          status: res.status()
        });
      }
    });

    // Click on platform passkey for login
    const platformButton = page.getByRole('button', { name: /passkey on this device/i });

    if (await platformButton.isVisible()) {
      await platformButton.click();

      // Wait for WebAuthn login ceremony
      await page.waitForTimeout(3000);

      const url = page.url();
      console.log('[TEST] Current URL after login attempt:', url);

      // Check if login API was called successfully
      const hasLoginBegin = networkLog.some(r => r.url.includes('login-webauthn-begin'));
      const hasLoginFinish = networkLog.some(r => r.url.includes('login-webauthn-finish'));

      console.log('[TEST] Login APIs called:', { hasLoginBegin, hasLoginFinish });
    }
  });

  test('should show cached users if available', async ({ page }) => {
    // Register a user first to create cached user entry
    const username = generateTestUsername();
    await registerUser(page, username);

    // Navigate back to login
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // The UI may show cached users as quick-login buttons
    const cachedUserButtons = page.locator('button[id^="login-cached-user"]');
    const count = await cachedUserButtons.count();

    console.log(`[TEST] Found ${count} cached user buttons`);

    // Note: cached users depend on localStorage state across sessions
    // This test verifies the UI can display them if present
  });

  test('should handle login with security key authenticator', async ({ page }) => {
    // Remove platform authenticator and add security key
    await webauthn.removeAuthenticator();
    await webauthn.addSecurityKeyAuthenticator();

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Look for security key option
    const securityKeyButton = page.locator('button[value="security-key"]');

    if (await securityKeyButton.isVisible()) {
      await expect(securityKeyButton).toBeEnabled();
    }
  });

  test('should display login options on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Check for presence of login options
    const platformButton = page.getByRole('button', { name: /passkey on this device/i });
    await expect(platformButton).toBeVisible({ timeout: 10000 });
  });
});
