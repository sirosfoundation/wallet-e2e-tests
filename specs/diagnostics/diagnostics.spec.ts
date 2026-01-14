/**
 * Diagnostic E2E Tests
 *
 * @tags @diagnostics
 *
 * These tests help identify compatibility issues between wallet-frontend and go-wallet-backend.
 * They capture detailed information about API responses and WebAuthn flows.
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername, toBase64Url, fromBase64Url } from '../../helpers/webauthn';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

test.describe('API Compatibility Diagnostics @diagnostics', () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('backend /status endpoint responds correctly', async () => {
    const response = await request.get('/status');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    console.log('Backend status:', JSON.stringify(data, null, 2));

    expect(data.status).toBe('ok');
    expect(data.service).toBe('wallet-backend');
  });

  test('registration-begin returns correct format', async () => {
    const response = await request.post('/user/register-webauthn-begin', {
      data: {},
    });

    expect(response.ok()).toBe(true);
    const data = await response.json();

    console.log('Registration begin response:', JSON.stringify(data, null, 2));

    // Validate structure expected by wallet-frontend
    expect(data.challengeId).toBeDefined();
    expect(data.createOptions).toBeDefined();
    expect(data.createOptions.publicKey).toBeDefined();

    const pk = data.createOptions.publicKey;
    expect(pk.rp).toBeDefined();
    expect(pk.rp.name).toBeDefined();
    expect(pk.user).toBeDefined();
    expect(pk.user.id).toBeDefined();
    expect(pk.challenge).toBeDefined();

    // Check tagged binary format
    expect(pk.challenge.$b64u).toBeDefined();
    expect(pk.user.id.$b64u).toBeDefined();
  });

  test('login-begin returns correct format', async () => {
    const response = await request.post('/user/login-webauthn-begin', {
      data: {},
    });

    expect(response.ok()).toBe(true);
    const data = await response.json();

    console.log('Login begin response:', JSON.stringify(data, null, 2));

    // Validate structure expected by wallet-frontend
    expect(data.challengeId).toBeDefined();
    expect(data.getOptions).toBeDefined();
    expect(data.getOptions.publicKey).toBeDefined();

    const pk = data.getOptions.publicKey;
    expect(pk.challenge).toBeDefined();
    expect(pk.challenge.$b64u).toBeDefined();
  });
});

test.describe('WebAuthn Flow Diagnostics @diagnostics', () => {
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

  test('frontend loads login page correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Check for key UI elements
    const title = await page.title();
    console.log('Page title:', title);

    // Check for passkey buttons
    const platformButton = page.locator('button[value="client-device"]');
    const isVisible = await platformButton.isVisible().catch(() => false);
    console.log('Platform passkey button visible:', isVisible);

    if (!isVisible) {
      // Log the page content for debugging
      const bodyText = await page.locator('body').textContent();
      console.log('Page body text:', bodyText?.substring(0, 500));
    }

    expect(isVisible).toBe(true);
  });

  test('diagnose registration flow step by step', async ({ page, request }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Check if we're on signup mode or need to switch
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      console.log('Found signup toggle, clicking...');
      await signupToggle.click();
      await page.waitForTimeout(500);
    }

    // Fill in name if present
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      const testName = generateTestUsername();
      console.log('Filling name:', testName);
      await nameInput.fill(testName);
    }

    // Listen for network requests
    const requests: { url: string; method: string; postData?: string }[] = [];
    page.on('request', req => {
      if (req.url().includes('localhost:8080')) {
        requests.push({
          url: req.url(),
          method: req.method(),
          postData: req.postData()?.substring(0, 200),
        });
      }
    });

    const responses: { url: string; status: number; body?: string }[] = [];
    page.on('response', async res => {
      if (res.url().includes('localhost:8080')) {
        let body = '';
        try {
          body = (await res.text()).substring(0, 500);
        } catch {}
        responses.push({
          url: res.url(),
          status: res.status(),
          body,
        });
      }
    });

    // Click platform passkey button
    const platformButton = page.locator('button[value="client-device"]');
    if (await platformButton.isVisible()) {
      console.log('Clicking platform passkey button...');
      await platformButton.click();

      // Wait for WebAuthn and network activity
      await page.waitForTimeout(5000);

      console.log('Network requests:', JSON.stringify(requests, null, 2));
      console.log('Network responses:', JSON.stringify(responses, null, 2));

      // Check credentials created
      const credentials = await webauthn.getCredentials();
      console.log('Credentials created:', credentials.length);
      if (credentials.length > 0) {
        console.log('First credential ID:', credentials[0].credentialId);
      }
    } else {
      console.log('Platform passkey button not found');
    }
  });

  test('check console errors during registration', async ({ page }) => {
    const consoleMessages: { type: string; text: string }[] = [];
    page.on('console', msg => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text().substring(0, 500),
      });
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Switch to signup mode
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(500);
    }

    // Fill name
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill(generateTestUsername());
    }

    // Click platform passkey
    const platformButton = page.locator('button[value="client-device"]');
    if (await platformButton.isVisible()) {
      await platformButton.click();
      await page.waitForTimeout(5000);
    }

    // Filter for errors
    const errors = consoleMessages.filter(m => m.type === 'error');
    console.log('Console errors:', errors);

    // Log all console messages for debugging
    console.log('All console messages:', consoleMessages);
  });
});
