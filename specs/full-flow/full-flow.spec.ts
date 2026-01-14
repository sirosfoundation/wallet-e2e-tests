/**
 * Full WebAuthn Flow E2E Tests with PRF
 *
 * @tags @full-flow
 *
 * These tests perform complete registration and login flows with detailed
 * logging to help debug compatibility issues between wallet-frontend and go-wallet-backend.
 */

import { test, expect, type Page, type Response } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername, toBase64Url } from '../../helpers/webauthn';

test.describe('Complete Registration Flow @full-flow', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    // Inject PRF mock BEFORE any navigation - required for wallet keystore
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  // This test captures detailed flow information, needs extra time
  test('should capture full registration flow details', { timeout: 60000 }, async ({ page }) => {
    const testName = generateTestUsername();

    // Capture all network traffic
    const requests: { url: string; method: string; body?: string }[] = [];
    const responses: { url: string; status: number; body?: string }[] = [];

    page.on('request', async req => {
      if (req.url().includes('localhost:8080')) {
        requests.push({
          url: req.url(),
          method: req.method(),
          body: req.postData()?.substring(0, 2000),
        });
      }
    });

    page.on('response', async res => {
      if (res.url().includes('localhost:8080')) {
        let body = '';
        try {
          body = await res.text();
        } catch {}
        responses.push({
          url: res.url(),
          status: res.status(),
          body: body.substring(0, 2000),
        });
      }
    });

    // Capture console output for debugging
    const consoleOutput: string[] = [];
    page.on('console', msg => {
      consoleOutput.push(`[${msg.type()}] ${msg.text()}`);
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
    await nameInput.fill(testName);

    // Click platform passkey button
    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    // Wait for the flow to complete
    await page.waitForTimeout(5000);

    // Handle PRF retry if needed
    const continueButton = page.locator('#continue-prf-loginsignup');
    if (await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('PRF retry prompt - clicking continue');
      await continueButton.click();
      await page.waitForTimeout(3000);
    }

    // Output detailed results
    console.log('\n=== REGISTRATION FLOW RESULTS ===\n');

    // Find the registration requests/responses
    const beginReq = requests.find(r => r.url.includes('register-webauthn-begin'));
    const finishReq = requests.find(r => r.url.includes('register-webauthn-finish'));
    const beginResp = responses.find(r => r.url.includes('register-webauthn-begin'));
    const finishResp = responses.find(r => r.url.includes('register-webauthn-finish'));

    if (beginResp) {
      console.log('register-webauthn-begin response status:', beginResp.status);
      if (beginResp.status === 200) {
        try {
          const parsed = JSON.parse(beginResp.body || '{}');
          console.log('  challengeId:', parsed.challengeId);
          console.log('  rp.id:', parsed.createOptions?.publicKey?.rp?.id);
          console.log('  has PRF extension:', !!parsed.createOptions?.publicKey?.extensions?.prf);
        } catch {}
      }
    }

    if (finishReq) {
      console.log('\nregister-webauthn-finish request body preview:');
      try {
        const parsed = JSON.parse(finishReq.body || '{}');
        console.log('  challengeId:', parsed.challengeId);
        console.log('  displayName:', parsed.displayName);
        console.log('  credential.type:', parsed.credential?.type);
        console.log('  credential.id (length):', parsed.credential?.id?.length);
        console.log('  has privateData:', !!parsed.privateData);
        if (parsed.privateData) {
          console.log('  privateData.jwe (preview):', parsed.privateData.jwe?.substring(0, 50));
          console.log('  privateData.prfKeys count:', parsed.privateData.prfKeys?.length);
        }
      } catch (e) {
        console.log('  Error parsing request:', e);
        console.log('  Raw body preview:', finishReq.body?.substring(0, 500));
      }
    }

    if (finishResp) {
      console.log('\nregister-webauthn-finish response:');
      console.log('  status:', finishResp.status);
      console.log('  body:', finishResp.body?.substring(0, 500));
    }

    // Check credentials created
    const credentials = await webauthn.getCredentials();
    console.log('\nCredentials in authenticator:', credentials.length);
    if (credentials.length > 0) {
      console.log('  Credential ID:', credentials[0].credentialId);
      console.log('  RP ID:', credentials[0].rpId);
    }

    // Check current page state
    const currentUrl = page.url();
    console.log('\nFinal page URL:', currentUrl);

    // Log relevant console output
    const relevantConsole = consoleOutput.filter(c =>
      c.includes('error') || c.includes('Error') || c.includes('PRF') || c.includes('keystore')
    );
    if (relevantConsole.length > 0) {
      console.log('\nRelevant console output:');
      relevantConsole.forEach(c => console.log(' ', c));
    }

    console.log('\n=== END REGISTRATION FLOW ===\n');

    // Test assertions
    expect(credentials.length).toBeGreaterThan(0);
  });

  test('should capture WebAuthn credential response details', async ({ page }) => {
    const testName = generateTestUsername();

    // Inject JavaScript to capture WebAuthn responses
    await page.addInitScript(() => {
      const originalCreate = navigator.credentials.create;
      (navigator.credentials as any).create = async function(options: CredentialCreationOptions) {
        console.log('[TEST] WebAuthn create called with options:', JSON.stringify({
          rpId: (options.publicKey as any)?.rp?.id,
          rpName: (options.publicKey as any)?.rp?.name,
          hasChallenge: !!(options.publicKey as any)?.challenge,
          hasPrfExtension: !!(options.publicKey as any)?.extensions?.prf,
          prfEval: (options.publicKey as any)?.extensions?.prf?.eval ? 'present' : 'not present',
        }));

        const credential = await originalCreate.call(this, options);

        const extResults = (credential as PublicKeyCredential).getClientExtensionResults();
        console.log('[TEST] WebAuthn create result extensions:', JSON.stringify({
          prf: extResults?.prf,
          credProps: extResults?.credProps,
        }));

        return credential;
      };
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
    await nameInput.fill(testName);

    // Capture console output
    const webauthnLogs: string[] = [];
    page.on('console', msg => {
      if (msg.text().includes('[TEST]')) {
        webauthnLogs.push(msg.text());
      }
    });

    // Click platform passkey button
    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    // Wait for WebAuthn flow
    await page.waitForTimeout(5000);

    // Handle PRF retry if needed
    const continueButton = page.locator('#continue-prf-loginsignup');
    if (await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueButton.click();
      await page.waitForTimeout(3000);
    }

    console.log('\n=== WEBAUTHN CREDENTIAL DETAILS ===\n');
    webauthnLogs.forEach(log => console.log(log));
    console.log('\n=== END DETAILS ===\n');

    // Verify credentials were created
    const credentials = await webauthn.getCredentials();
    expect(credentials.length).toBeGreaterThan(0);
  });
});

test.describe('Full Login Flow After Registration @full-flow', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    // Inject PRF mock BEFORE any navigation - required for wallet keystore
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('should attempt full registration then login cycle', async ({ page }) => {
    const testName = generateTestUsername();

    // Track responses
    let registrationSuccess = false;
    let loginAttempted = false;

    page.on('response', async res => {
      if (res.url().includes('register-webauthn-finish') && res.status() === 200) {
        registrationSuccess = true;
      }
      if (res.url().includes('login-webauthn-begin')) {
        loginAttempted = true;
      }
    });

    console.log('\n=== REGISTRATION PHASE ===');

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Switch to signup
    const signupToggle = page.getByRole('button', { name: /sign up|create/i });
    if (await signupToggle.isVisible()) {
      await signupToggle.click();
      await page.waitForTimeout(300);
    }

    // Fill name and register
    const nameInput = page.locator('input[name="name"]');
    await nameInput.fill(testName);

    const platformButton = page.locator('button[value="client-device"]');
    await platformButton.click();

    await page.waitForTimeout(5000);

    // Handle PRF retry
    const continueButton = page.locator('#continue-prf-loginsignup');
    if (await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueButton.click();
      await page.waitForTimeout(3000);
    }

    console.log('Registration success:', registrationSuccess);

    // Check if we're logged in (redirected to home)
    const currentUrl = page.url();
    const isLoggedIn = !currentUrl.includes('/login');
    console.log('Appears logged in:', isLoggedIn, 'URL:', currentUrl);

    if (isLoggedIn) {
      console.log('\n=== LOGIN PHASE (after logout) ===');

      // Log out and try to log back in
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      // Try to login with cached credential
      const cachedUserButton = page.locator('[id^="login-cached-user"]').first();
      if (await cachedUserButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('Found cached user button, clicking...');
        await cachedUserButton.click();
        await page.waitForTimeout(3000);

        // Handle PRF retry for login
        if (await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
          await continueButton.click();
          await page.waitForTimeout(3000);
        }

        console.log('Login attempted:', loginAttempted);
      } else {
        console.log('No cached user found for login test');
      }
    }

    console.log('\n=== END CYCLE TEST ===\n');

    // At minimum, verify credential was created
    const credentials = await webauthn.getCredentials();
    expect(credentials.length).toBeGreaterThan(0);
  });
});
