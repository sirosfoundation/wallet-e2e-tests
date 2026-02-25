/**
 * Full Credential Flow E2E Tests
 *
 * @tags @real-webauthn @e2e @credential-flow
 *
 * These tests exercise complete credential issuance and verification flows:
 * 1. Register/login user via WebAuthn
 * 2. Obtain credential from mock issuer via OpenID4VCI
 * 3. Present credential to mock verifier via OpenID4VP
 *
 * Prerequisites:
 *   - Run full-flow mock issuer on port 9000
 *   - Run full-flow mock verifier on port 9001
 *   - SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   - make test-credential-flow
 */

import { test, expect, request } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  fetchBackendStatus,
  isWebSocketAvailable,
  getTransportDescription,
  clearStatusCache,
} from '../../helpers/backend-capabilities';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ISSUER_URL = process.env.ISSUER_URL || 'http://localhost:9000';
const VERIFIER_URL = process.env.VERIFIER_URL || 'http://localhost:9001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a new user via the frontend UI.
 * Copied from user-flows.spec.ts for self-contained tests.
 */
async function registerUserViaUI(
  page: Page,
  options: { username: string; tenantId?: string }
): Promise<{ success: boolean; userId?: string; error?: string }> {
  const loginUrl = options.tenantId
    ? `${FRONTEND_URL}/id/${options.tenantId}/login`
    : `${FRONTEND_URL}/login`;

  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Track API responses and errors
  let finishResponse: any = null;
  let apiError: string | undefined;
  const pageErrors: string[] = [];

  // Capture page errors
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.log(`[PAGE ERROR] ${error.message}`);
  });

  // Capture console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[CONSOLE ERROR] ${msg.text()}`);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('register-webauthn-finish')) {
      try {
        const data = await response.json();
        if (response.status() === 200) {
          finishResponse = data;
        } else {
          apiError = data.error || `HTTP ${response.status()}`;
        }
      } catch {
        // Ignore JSON parse errors
      }
    } else if (url.includes('register-webauthn-begin') && !response.ok()) {
      try {
        const data = await response.json();
        apiError = data.error || `Begin failed: HTTP ${response.status()}`;
      } catch {
        apiError = `Begin failed: HTTP ${response.status()}`;
      }
    }
  });

  // Switch to signup mode
  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signUpSwitch.click();
    await page.waitForTimeout(500);
  }

  // Fill username
  const nameInput = page.locator('input[name="name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(options.username);

  // Click security-key signup button
  // soft-fido2 presents as a USB HID authenticator, not a platform authenticator
  const signupButton = page.locator('[id*="signUpPasskey"][id*="security-key"][id*="submit"]');
  await expect(signupButton).toBeVisible({ timeout: 10000 });

  const WEBAUTHN_TIMEOUT = 20000;
  
  try {
    // Start waiting for the finish response before clicking
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('register-webauthn-finish'),
      { timeout: WEBAUTHN_TIMEOUT * 2 } // Allow time for PRF retry
    );
    
    await signupButton.click();
    
    // Wait for the first WebAuthn ceremony to complete
    await page.waitForTimeout(3000);
    
    // Check if PRF retry dialog appeared ("Almost done!")
    const continueButton = page.locator('button:has-text("Continue")');
    if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('PRF retry dialog detected, clicking Continue...');
      await continueButton.click();
    }
    
    // Wait for the finish response with explicit timeout handling
    await Promise.race([
      responsePromise,
      page.waitForTimeout(WEBAUTHN_TIMEOUT).then(() => {
        throw new Error('WebAuthn operation timed out - credential picker may be waiting');
      }),
    ]);
  } catch (error) {
    const errorMsg = String(error);
    
    // Check for UI error message
    const errorEl = page.locator('text=Failed to initiate, text=error, text=Error').first();
    const uiError = await errorEl.textContent({ timeout: 1000 }).catch(() => null);
    
    if (apiError) {
      return { success: false, error: apiError };
    }
    if (uiError) {
      return { success: false, error: uiError };
    }
    if (pageErrors.length > 0) {
      return { success: false, error: pageErrors.join('; ') };
    }
    return { success: false, error: errorMsg };
  }

  // Wait a bit for the response to be captured
  await page.waitForTimeout(500);

  if (finishResponse) {
    return { success: true, userId: finishResponse.uuid };
  }

  if (apiError) {
    return { success: false, error: apiError };
  }

  return { success: false, error: 'No finish response captured' };
}

/**
 * Login a user via the frontend UI.
 */
async function loginUserViaUI(
  page: Page,
  options: { tenantId?: string; expectCachedUser?: boolean; cachedUserIndex?: number } = {}
): Promise<{ success: boolean; userId?: string; error?: string }> {
  const loginUrl = options.tenantId
    ? `${FRONTEND_URL}/id/${options.tenantId}/login`
    : `${FRONTEND_URL}/login`;

  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Track API responses and errors
  let finishResponse: any = null;
  let finishStatus: number | undefined;
  let apiError: string | undefined;
  const pageErrors: string[] = [];

  // Capture page errors
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.log(`[PAGE ERROR] ${error.message}`);
  });

  // Capture console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[CONSOLE ERROR] ${msg.text()}`);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('login-webauthn-finish')) {
      finishStatus = response.status();
      try {
        finishResponse = await response.json();
      } catch {
        // Ignore JSON parse errors
      }
    } else if (url.includes('login-webauthn-begin') && !response.ok()) {
      try {
        const data = await response.json();
        apiError = data.error || `Begin failed: HTTP ${response.status()}`;
      } catch {
        apiError = `Begin failed: HTTP ${response.status()}`;
      }
    }
  });

  // Determine which button to click
  let loginButton;
  if (options.expectCachedUser !== false) {
    // Try to find cached user button first
    const cachedIndex = options.cachedUserIndex ?? 0;
    const cachedUserButton = page.locator(`#login-cached-user-${cachedIndex}-loginsignup`);
    if (await cachedUserButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      loginButton = cachedUserButton;
    }
  }

  if (!loginButton) {
    // Fall back to security-key (USB/roaming) passkey login button
    // soft-fido2 presents as a USB HID authenticator, not a platform authenticator
    loginButton = page.locator('#loginPasskey-security-key-submit-loginsignup');
  }

  await expect(loginButton).toBeVisible({ timeout: 15000 });

  // Click and wait for login to complete with timeout
  const WEBAUTHN_TIMEOUT = 15000;
  
  try {
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('login-webauthn-finish'),
      { timeout: WEBAUTHN_TIMEOUT }
    );
    
    await loginButton.click();
    
    // Race between response and timeout
    await Promise.race([
      responsePromise,
      page.waitForTimeout(WEBAUTHN_TIMEOUT).then(() => {
        throw new Error('WebAuthn operation timed out - credential picker may be waiting');
      }),
    ]);
  } catch (error) {
    // Check for UI error message
    const errorEl = page.locator('text=Failed to initiate').first();
    const uiError = await errorEl.textContent({ timeout: 1000 }).catch(() => null);
    
    if (apiError) {
      return { success: false, error: apiError };
    }
    if (uiError) {
      return { success: false, error: uiError };
    }
    if (pageErrors.length > 0) {
      return { success: false, error: pageErrors.join('; ') };
    }
    return { success: false, error: String(error) };
  }

  await page.waitForTimeout(500);

  if (finishResponse && finishStatus === 200) {
    return { success: true, userId: finishResponse.uuid };
  }

  if (apiError) {
    return { success: false, error: apiError };
  }

  return { success: false, error: 'No finish response captured' };
}

/**
 * Wait for the wallet to be ready (logged in and on home page)
 * Also handles the welcome tour dialog that appears on first login
 */
async function waitForWalletReady(page: Page): Promise<void> {
  // Wait for navigation away from login page OR for home page elements
  // Use a longer timeout since login can take a moment to redirect
  const startTime = Date.now();
  const maxWait = 30000; // 30 seconds total
  
  while (Date.now() - startTime < maxWait) {
    // Check if we're no longer on the login page
    const currentUrl = page.url();
    if (!currentUrl.includes('/login')) {
      // Give the page a moment to render
      await page.waitForTimeout(500);
      break;
    }
    
    // Check for home page elements
    const hasHomePage = await page.locator('[data-testid="home-page"], h1:has-text("My Wallet"), h1:has-text("Credentials"), [class*="credential"]').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasHomePage) {
      break;
    }
    
    await page.waitForTimeout(500);
  }
  
  // Final check - if still on login, throw error
  const finalUrl = page.url();
  if (finalUrl.includes('/login')) {
    throw new Error(`Timeout waiting for wallet to be ready - still on login page: ${finalUrl}`);
  }
  
  // Handle the welcome tour dialog that appears on first login
  const dismissButton = page.locator('button:has-text("Dismiss")').first();
  if (await dismissButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('Dismissing welcome tour dialog...');
    await dismissButton.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Navigate to a credential offer and accept it.
 * Note: The welcome tour dialog should already be dismissed in waitForWalletReady()
 * 
 * The wallet's UriHandlerProvider processes credential_offer_uri params after sync completes.
 * Flow:
 * 1. Navigate to wallet with credential_offer_uri param
 * 2. Wallet syncs private data
 * 3. UriHandlerProvider processes the offer and redirects to issuer's authorize endpoint
 * 4. User "consents" at issuer (mock issuer auto-approves)
 * 5. Issuer redirects back to wallet with authorization code
 * 6. Wallet exchanges code for credentials
 */
async function acceptCredentialOffer(
  page: Page,
  offerUrl: string
): Promise<{ success: boolean; credentialId?: string; error?: string }> {
  console.log('Navigating to credential offer:', offerUrl);
  
  // Navigate to the offer URL - the wallet should detect and handle it
  await page.goto(offerUrl);
  
  // Wait for the page to fully load
  await page.waitForLoadState('networkidle');
  
  // The wallet needs to sync before UriHandlerProvider processes the URL.
  // Wait for possible redirect to issuer's authorization endpoint.
  // The mock issuer's authorize endpoint will auto-approve and redirect back.
  console.log('Waiting for wallet to process credential offer...');
  
  // Wait longer for the wallet's UriHandlerProvider to process the URL
  // This requires: isLoggedIn && synced && url has params
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const currentUrl = page.url();
    
    // Check if we were redirected to the issuer's authorize endpoint
    if (currentUrl.includes('/authorize') || currentUrl.includes('localhost:9000')) {
      console.log('Redirected to issuer authorization:', currentUrl);
      // Wait for issuer to redirect back with auth code
      await page.waitForURL(/code=|credential/, { timeout: 30000 }).catch(() => {});
      break;
    }
    
    // Check if we already have an authorization code (direct callback)
    if (currentUrl.includes('code=')) {
      console.log('Authorization code received:', currentUrl);
      break;
    }
    
    // Check for credential offer modal/UI
    const modal = page.locator('.ReactModal__Content, [role="dialog"], .modal-content').first();
    if (await modal.isVisible().catch(() => false)) {
      console.log('Credential offer modal appeared');
      break;
    }
  }
  
  await page.waitForTimeout(2000);
  
  // Check for a modal dialog (React Modal pattern) - could be credential offer acceptance
  const modal = page.locator('.ReactModal__Content, [role="dialog"], .modal-content').first();
  const isModalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
  
  if (isModalVisible) {
    console.log('Found modal dialog');
    const modalText = await modal.textContent().catch(() => '');
    console.log('Modal snippet:', modalText?.substring(0, 100));
    
    // Look for buttons inside the modal
    const modalAcceptButton = modal.locator(
      'button:has-text("Accept"), button:has-text("Add"), button:has-text("Get Credential"), button:has-text("Continue"), button:has-text("Proceed"), button:has-text("Get")'
    ).first();
    
    if (await modalAcceptButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Found accept button in modal, clicking...');
      await modalAcceptButton.click();
      await page.waitForTimeout(2000);
    }
  }
  
  // Only click Add Credentials if we're still on the home page without progress
  const currentUrl = page.url();
  if (!currentUrl.includes('code=') && !currentUrl.includes('/authorize')) {
    const addCredButton = page.locator('button:has-text("Add New Credential"), button:has-text("Add Credentials")').first();
    if (await addCredButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Clicking add credential button...');
      await addCredButton.click();
      await page.waitForTimeout(2000);
    }
  }

  // Check if we need to handle any additional prompts/modals
  for (let i = 0; i < 3; i++) {
    const continueButton = page.locator('.ReactModal__Content button:has-text("Continue"), button:has-text("Continue"), button:has-text("Confirm")').first();
    if (await continueButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Found continue button, clicking...');
      await continueButton.click();
      await page.waitForTimeout(1000);
    } else {
      break;
    }
  }

  // Wait for the credential to be added - look for success indicators
  const successIndicator = page.locator(
    'text=successfully, text=added, text=received, text=stored, [data-testid="credential-added"]'
  ).first();
  
  const isSuccess = await successIndicator.isVisible({ timeout: 15000 }).catch(() => false);
  
  if (isSuccess) {
    console.log('Success indicator found');
    return { success: true };
  }

  // Check if a credential card/button now exists
  // The wallet displays credentials as buttons with the credential type name
  await page.waitForTimeout(2000);
  
  // First check for explicit credential cards
  const credentialCard = page.locator('[data-testid="credential-card"], .credential-card, [class*="credential-item"]').first();
  if (await credentialCard.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('Credential card found');
    return { success: true };
  }
  
  // Check for identity credential button (how wwWallet displays credentials)
  const identityCredential = page.locator('button:has-text("Identity Credential"), button:has-text("identity_credential")').first();
  if (await identityCredential.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('Identity credential found in wallet');
    return { success: true };
  }
  
  // Check for any credential-like element in the credentials list
  const credentialsHeading = page.locator('heading:has-text("Credentials"), h1:has-text("Credentials")').first();
  if (await credentialsHeading.isVisible().catch(() => false)) {
    // If we're on the credentials page and there's credential content, it might be there
    const anyCredentialButton = page.locator('button[aria-label*="Credential"], button:has-text("Credential")').first();
    if (await anyCredentialButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Credential button found on credentials page');
      return { success: true };
    }
  }

  console.log('Current URL:', page.url());
  return { success: false, error: 'Could not confirm credential was added' };
}

/**
 * Start verification request and handle the presentation flow
 */
async function presentCredential(
  page: Page,
  verificationUrl: string
): Promise<{ success: boolean; error?: string }> {
  console.log('Starting verification flow:', verificationUrl);
  
  // Navigate to the verification URL
  await page.goto(verificationUrl);
  await page.waitForTimeout(2000);
  
  // The wallet should show a credential selection/consent dialog
  // Look for the consent/share button
  const shareButton = page.locator(
    'button:has-text("Share"), button:has-text("Present"), button:has-text("Send"), button:has-text("Confirm"), button:has-text("Continue")'
  ).first();
  
  if (await shareButton.isVisible({ timeout: 10000 }).catch(() => false)) {
    console.log('Found share button, clicking...');
    await shareButton.click();
    await page.waitForTimeout(2000);
  }
  
  // Handle additional confirmation dialogs
  const confirmButton = page.locator('button:has-text("Confirm"), button:has-text("Yes")').first();
  if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmButton.click();
    await page.waitForTimeout(1000);
  }

  // Wait for the verification to complete
  // This could redirect to the verifier's success page or show a success message
  await page.waitForTimeout(3000);
  
  // Check for success - either on verifier success page or wallet confirmation
  const currentUrl = page.url();
  if (currentUrl.includes('/success') || currentUrl.includes('verification')) {
    return { success: true };
  }
  
  const successIndicator = page.locator(
    'text=success, text=verified, text=complete, text=shared, [data-testid="verification-complete"]'
  ).first();
  
  if (await successIndicator.isVisible({ timeout: 5000 }).catch(() => false)) {
    return { success: true };
  }

  return { success: false, error: 'Could not confirm verification completed' };
}

// Configure tests to run serially to avoid credential conflicts
test.describe.configure({ mode: 'serial' });

test.describe('Full Credential Flow', () => {
  let username: string;
  let userId: string | undefined;
  let wsAvailable: boolean;

  test.beforeAll(async () => {
    username = `flow-user-${generateTestId()}`;
    clearStatusCache();

    // Log transport capabilities for test visibility
    const transportDesc = await getTransportDescription();
    wsAvailable = await isWebSocketAvailable();
    console.log(`\n=== Backend Capabilities ===`);
    console.log(`Transport: ${transportDesc}`);
    console.log(`WebSocket available: ${wsAvailable}`);
    console.log(`============================\n`);
  });

  test('backend is healthy and reports capabilities', async ({ request }) => {
    const status = await fetchBackendStatus(true);
    expect(status).not.toBeNull();
    expect(status?.status).toBe('ok');

    console.log(`Backend version: ${status?.version || 'unknown'}`);
    console.log(`API version: ${status?.api_version || 1}`);
    console.log(`Capabilities: ${(status?.capabilities || []).join(', ') || 'none'}`);
  });

  test('mock issuer is healthy', async ({ request }) => {
    const response = await request.get(`${ISSUER_URL}/health`);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    // Handle both mock format ({status: 'ok'}) and VC format ({data: {status: 'STATUS_OK_...'})
    const isHealthy = data.status === 'ok' || (data.data?.status?.startsWith('STATUS_OK'));
    expect(isHealthy).toBe(true);
  });

  test('mock verifier is healthy', async ({ request }) => {
    const response = await request.get(`${VERIFIER_URL}/health`);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    // Handle both mock format ({status: 'ok'}) and VC format ({data: {status: 'STATUS_OK_...'})
    const isHealthy = data.status === 'ok' || (data.data?.status?.startsWith('STATUS_OK'));
    expect(isHealthy).toBe(true);
  });

  test('register new user', async ({ page }) => {
    const result = await registerUserViaUI(page, { username });
    expect(result.success).toBe(true);
    expect(result.userId).toBeDefined();
    userId = result.userId;
    console.log(`Registered user: ${username} (${userId})`);
    
    // Wait for home page
    await waitForWalletReady(page);
    
    // Also test that login works immediately after registration (same context has cached user)
    // Navigate to login page to force re-auth
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');
    
    // Should see cached user button since we just registered
    const cachedUserButton = page.locator('#login-cached-user-0-loginsignup');
    if (await cachedUserButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Cached user found, testing login...');
      await cachedUserButton.click();
      await page.waitForResponse(
        (response) => response.url().includes('login-webauthn-finish'),
        { timeout: 15000 }
      );
      await waitForWalletReady(page);
      console.log('Login via cached user successful');
    }
  });

  test('obtain credential via OpenID4VCI (pre-authorized)', async ({ page, request }) => {
    // Check if we're running against mock or VC services
    // The mock issuer has /offer endpoint, VC services don't
    const offerCheck = await request.get(`${ISSUER_URL}/offer`).catch(() => null);
    if (!offerCheck || !offerCheck.ok()) {
      test.skip(true, 'Skipping mock-specific test - no /offer endpoint (likely using VC services)');
    }

    // Test credential issuance via authorization_code grant flow.
    // The mock issuer now provides both authorization_code and pre-authorized_code grants.
    // The wallet only supports authorization_code grant, which should now work.
    
    // Enable console logging to see wallet logs
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('Uri Handler') || text.includes('credential') || text.includes('sync') || text.includes('Actually')) {
        console.log(`  [browser] ${text}`);
      }
    });
    
    // First register a fresh user for this test (each test gets fresh browser context)
    const testUsername = `vci-user-${generateTestId()}`;
    const regResult = await registerUserViaUI(page, { username: testUsername });
    expect(regResult.success).toBe(true);
    await waitForWalletReady(page);  // This dismisses the welcome dialog
    console.log(`Registered user for VCI test: ${testUsername}`);
    
    // Give the wallet time to complete initial sync before navigating with offer
    console.log('Waiting for initial sync to complete...');
    await page.waitForTimeout(3000);


    // Get a credential offer from the mock issuer
    const offerResponse = await request.get(`${ISSUER_URL}/offer`);
    expect(offerResponse.ok()).toBe(true);
    const offerData = await offerResponse.json();
    expect(offerData.credential_offer_uri).toBeDefined();
    
    console.log('Got credential offer:', offerData);

    // Navigate to the offer URL which should open in the wallet
    // The wallet URL format can be either:
    // - openid-credential-offer://... (deep link)
    // - http://wallet/?credential_offer_uri=... (redirect)
    const walletOfferUrl = `${FRONTEND_URL}/?credential_offer_uri=${encodeURIComponent(offerData.credential_offer_uri)}`;
    
    const issueResult = await acceptCredentialOffer(page, walletOfferUrl);
    expect(issueResult.success).toBe(true);
    
    console.log('Credential obtained successfully');
  });

  test.skip('present credential via OpenID4VP', async ({ page, request }) => {
    // SKIP: Requires wallet frontend to handle OID4VP presentation requests.
    // The mock verifier provides valid OID4VP requests, but the wwWallet frontend
    // needs to implement handling for verification request URIs.
    
    // This test is self-contained: register, get credential, then present it
    
    // Step 1: Register a fresh user
    const testUsername = `vp-user-${generateTestId()}`;
    const regResult = await registerUserViaUI(page, { username: testUsername });
    expect(regResult.success).toBe(true);
    await waitForWalletReady(page);
    console.log(`Registered user for VP test: ${testUsername}`);

    // Step 2: Get a credential from the mock issuer
    const offerResponse = await request.get(`${ISSUER_URL}/offer`);
    expect(offerResponse.ok()).toBe(true);
    const offerData = await offerResponse.json();
    const walletOfferUrl = `${FRONTEND_URL}/?credential_offer_uri=${encodeURIComponent(offerData.credential_offer_uri)}`;
    const issueResult = await acceptCredentialOffer(page, walletOfferUrl);
    expect(issueResult.success).toBe(true);
    console.log('Got credential for VP test');

    // Step 3: Create a verification request at the mock verifier
    const verifyResponse = await request.post(`${VERIFIER_URL}/create-request`);
    expect(verifyResponse.ok()).toBe(true);
    const verifyData = await verifyResponse.json();
    expect(verifyData.wallet_url).toBeDefined();
    
    console.log('Got verification request:', verifyData);

    // Step 4: Navigate to the wallet URL with the verification request
    const presentResult = await presentCredential(page, verifyData.wallet_url);
    expect(presentResult.success).toBe(true);
    
    // Verify the verifier received the presentation
    const statusResponse = await request.get(`${VERIFIER_URL}/status/${verifyData.request_id}`);
    expect(statusResponse.ok()).toBe(true);
    const statusData = await statusResponse.json();
    expect(statusData.status).toBe('completed');
    expect(statusData.has_response).toBe(true);
    
    console.log('Verification completed successfully');
  });
});

test.describe('Credential Flow with Authorization Code', () => {
  test.skip('obtain credential via OpenID4VCI (authorization code flow)', async ({ page, request }) => {
    // This test is more complex as it requires OAuth authorization
    // The wallet needs to:
    // 1. Start with a credential offer
    // 2. Redirect to the issuer's authorization endpoint
    // 3. User authenticates/consents at issuer
    // 4. Redirect back to wallet with authorization code
    // 5. Wallet exchanges code for tokens
    // 6. Wallet requests credential
    
    // For now, this is skipped as it requires more sophisticated mock issuer
    // that can handle the full OAuth flow with user interaction
  });
});

test.describe('Error Handling', () => {
  test.skip('handles invalid credential offer gracefully', async ({ page }) => {
    // SKIP: Requires wallet frontend to process credential_offer_uri.
    // When the frontend supports credential offers, this test verifies
    // that invalid offers are handled gracefully without breaking the wallet.
    
    // Login first
    const username = `error-test-${generateTestId()}`;
    const regResult = await registerUserViaUI(page, { username });
    expect(regResult.success).toBe(true);
    await waitForWalletReady(page);
    
    // Try to accept an invalid credential offer
    const invalidOfferUrl = `${FRONTEND_URL}/?credential_offer_uri=https://invalid.example.com/offer`;
    
    await page.goto(invalidOfferUrl);
    await page.waitForTimeout(3000);
    
    // The wallet should show an error or just ignore the invalid offer
    // Check that we're not stuck and the wallet is still usable
    const homeLink = page.locator('a:has-text("Home"), [data-testid="home-link"]').first();
    const isUsable = await homeLink.isVisible({ timeout: 5000 }).catch(() => {
      // Check if we're on a working page
      return page.locator('body').isVisible();
    });
    
    expect(isUsable).toBe(true);
  });

  test.skip('handles verification request for non-existent credential', async ({ page, request }) => {
    // SKIP: Requires wallet frontend to handle OID4VP verification requests.
    // When the frontend supports verification requests, this test verifies
    // that requests for non-existent credentials are handled gracefully.
    // Register a fresh user with no credentials
    const username = `no-cred-${generateTestId()}`;
    const regResult = await registerUserViaUI(page, { username });
    expect(regResult.success).toBe(true);
    await waitForWalletReady(page);
    
    // Create a verification request
    const verifyResponse = await request.post(`${VERIFIER_URL}/create-request`);
    expect(verifyResponse.ok()).toBe(true);
    const verifyData = await verifyResponse.json();
    
    // Navigate to verification - should show no matching credentials
    await page.goto(verifyData.wallet_url);
    await page.waitForTimeout(3000);
    
    // The wallet should show some indication that no matching credentials exist
    // or simply not show the share dialog
    const noCredentialsMsg = page.locator(
      'text=no matching, text=no credentials, text=not found, text=cannot find'
    ).first();
    
    const shareButton = page.locator('button:has-text("Share"), button:has-text("Present")').first();
    
    // Either we see a "no credentials" message or the share button is not available
    const hasNoCredsMsg = await noCredentialsMsg.isVisible({ timeout: 5000 }).catch(() => false);
    const hasShareButton = await shareButton.isVisible({ timeout: 2000 }).catch(() => false);
    
    // At least one of these should be true: no credentials message OR no share button
    expect(hasNoCredsMsg || !hasShareButton).toBe(true);
  });
});
