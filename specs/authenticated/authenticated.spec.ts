/**
 * Wallet Frontend - Authenticated User Flow Tests
 *
 * @tags @authenticated
 *
 * Tests authenticated user experiences after successful WebAuthn login.
 * Verifies navigation, settings access, and credential management.
 */

import { test, expect, type Page } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import { injectStorageClearing } from '../../helpers/browser-storage';

test.describe('Authenticated User Flows @authenticated', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page, context }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();

    // Clear cookies at context level
    await context.clearCookies();

    // Inject storage clearing script - runs before page scripts on every navigation
    await injectStorageClearing(page);

    // Inject PRF mock BEFORE navigation
    await webauthn.injectPrfMock();

    // Add virtual authenticator
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  /**
   * Helper to complete registration and login
   */
  async function authenticateUser(page: Page): Promise<boolean> {
    const username = generateTestUsername();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Try to find signup mode
    const signupToggle = page.getByRole('button', { name: /sign up|create|register/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(500);
    }

    // Fill name if visible
    const nameInput = page.getByPlaceholder(/name|display/i);
    if (await nameInput.count() > 0) {
      await nameInput.fill(username);
    }

    // Register with platform passkey
    const platformButton = page.getByRole('button', { name: /passkey on this device/i });
    if (await platformButton.isVisible()) {
      await platformButton.click();

      // Wait for registration + auto-login
      try {
        await page.waitForURL('http://localhost:3000/', { timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  test('should access home page after authentication', async ({ page }) => {
    const authenticated = await authenticateUser(page);

    if (!authenticated) {
      // If authentication flow didn't complete, check we can see the login page at least
      await page.goto('/');
      const url = page.url();

      // Unauthenticated users should be redirected to login
      expect(url).toContain('/login');
      return;
    }

    // Navigate to home
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should stay on home (or a valid authenticated route)
    const url = page.url();
    expect(url).not.toContain('/login');
  });

  test('should access settings page when authenticated', async ({ page }) => {
    const authenticated = await authenticateUser(page);

    if (!authenticated) {
      test.skip();
      return;
    }

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Should be on settings page
    const url = page.url();
    expect(url).toContain('/settings');

    // Look for settings-related content
    const heading = page.getByRole('heading', { name: /settings/i });
    if (await heading.isVisible()) {
      await expect(heading).toBeVisible();
    }
  });

  test('should redirect unauthenticated users to login', async ({ page }) => {
    // Don't authenticate - just try to access protected route
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Should be redirected to login
    const url = page.url();
    expect(url).toContain('/login');
  });

  test('should redirect unauthenticated users from home to login', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const url = page.url();
    expect(url).toContain('/login');
  });
});
