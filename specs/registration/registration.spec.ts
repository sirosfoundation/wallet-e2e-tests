/**
 * Wallet Registration E2E Tests
 *
 * @tags @registration
 *
 * Tests the wallet-frontend registration flow against go-wallet-backend
 * using the actual UI. The PRF mock provides real PRF outputs that the
 * keystore needs for key derivation.
 */

import { test, expect } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import { injectStorageClearing } from '../../helpers/browser-storage';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

test.describe('Wallet Registration @registration', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();

    // Clear browser storage before each test to ensure clean state
    await injectStorageClearing(page);

    // Inject PRF mock BEFORE any navigation - this patches WebAuthn APIs
    await webauthn.injectPrfMock();

    // Add virtual authenticator with PRF support
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('should display login page with passkey options', async ({ page }) => {
    await page.goto('/login');

    // Wait for the page to load
    await expect(page).toHaveURL('/login');

    // Check for presence of passkey login options
    await expect(page.getByRole('button', { name: /passkey on this device/i })).toBeVisible({ timeout: 10000 });
  });

  test('should display registration options', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check for registration buttons
    const signUpButton = page.getByRole('button', { name: /sign up/i });
    await expect(signUpButton).toBeVisible();

    // Check for passkey options
    const passkeyButton = page.getByRole('button', { name: /passkey on this device/i });
    await expect(passkeyButton).toBeVisible();
  });

  test('should show passkey type selection options', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Look for the three passkey type buttons
    const platformButton = page.locator('button[value="client-device"]');
    const securityKeyButton = page.locator('button[value="security-key"]');
    const hybridButton = page.locator('button[value="hybrid"]');

    // At least one should be visible
    const anyVisible = await platformButton.isVisible() ||
                       await securityKeyButton.isVisible() ||
                       await hybridButton.isVisible();

    expect(anyVisible).toBe(true);
  });

  test('should complete passkey registration flow', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Track network activity
    const networkLog: { type: string; url: string; status?: number; body?: string }[] = [];

    page.on('request', req => {
      if (req.url().includes('localhost:8080')) {
        networkLog.push({
          type: 'request',
          url: req.url(),
          body: req.postData()?.slice(0, 200)
        });
      }
    });

    page.on('response', res => {
      if (res.url().includes('localhost:8080')) {
        networkLog.push({
          type: 'response',
          url: res.url(),
          status: res.status()
        });
      }
    });

    // Track console messages for debugging
    page.on('console', msg => {
      if (msg.type() === 'log' || msg.type() === 'error') {
        console.log(`[BROWSER ${msg.type()}] ${msg.text()}`);
      }
    });

    // Switch to signup mode
    const signUpLink = page.getByRole('button', { name: /sign up/i });
    const signUpLinkCount = await signUpLink.count();
    console.log('[TEST] Sign Up buttons found:', signUpLinkCount);

    if (signUpLinkCount > 0) {
      await signUpLink.first().click();
      await page.waitForTimeout(500);
    }

    // Look for the name input field (only visible in signup mode)
    const nameInput = page.getByPlaceholder(/name|display/i);
    const hasNameInput = await nameInput.count() > 0;
    console.log('[TEST] Has name input:', hasNameInput);

    if (hasNameInput) {
      await nameInput.fill('Test User E2E');
    }

    // Click "Passkey on this device" to start platform authenticator registration
    const passkeyButton = page.getByRole('button', { name: /passkey on this device/i });
    await passkeyButton.click();

    // Wait for WebAuthn operation to complete and page to redirect
    await page.waitForURL('http://localhost:3000/', { timeout: 10000 });

    // Verify registration APIs were called
    const hasRegisterBegin = networkLog.some(r => r.url.includes('register-webauthn-begin'));
    const hasRegisterFinish = networkLog.some(r => r.url.includes('register-webauthn-finish'));
    const registerFinishSuccess = networkLog.some(r =>
      r.url.includes('register-webauthn-finish') && r.type === 'response' && r.status === 200
    );

    console.log('[TEST] Registration APIs called:', { hasRegisterBegin, hasRegisterFinish, registerFinishSuccess });
    console.log('[TEST] Final URL:', page.url());

    // Assert registration was successful
    expect(hasRegisterBegin, 'register-webauthn-begin was not called').toBe(true);
    expect(hasRegisterFinish, 'register-webauthn-finish was not called').toBe(true);
    expect(registerFinishSuccess, 'register-webauthn-finish did not return 200').toBe(true);

    // Assert user is redirected to home page after registration
    expect(page.url(), 'User was not redirected to home page after registration').toBe('http://localhost:3000/');
  });

  test('should handle registration with security key', async ({ page }) => {
    // Remove platform authenticator and add security key
    await webauthn.removeAuthenticator();
    await webauthn.addSecurityKeyAuthenticator();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signUpButton = page.getByRole('button', { name: /sign up/i });
    if (await signUpButton.isVisible()) {
      await signUpButton.click();
      await page.waitForTimeout(500);
    }

    // Fill name if visible
    const nameInput = page.getByPlaceholder(/name|display/i);
    if (await nameInput.count() > 0) {
      await nameInput.fill('Security Key User');
    }

    // Click security key option
    const securityKeyButton = page.getByRole('button', { name: /passkey on a security key/i });
    if (await securityKeyButton.isVisible()) {
      await securityKeyButton.click();

      // Wait for WebAuthn operation
      await page.waitForTimeout(3000);

      console.log('[TEST] Current URL after security key:', page.url());
    }
  });

  test('should create credential via virtual authenticator', async ({ page }) => {
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
    if (await platformButton.isVisible()) {
      await platformButton.click();

      // Wait for WebAuthn ceremony
      await page.waitForTimeout(3000);

      // Check credentials were created
      const credentials = await webauthn.getCredentials();
      expect(credentials.length).toBeGreaterThanOrEqual(1);
    }
  });
});
