/**
 * TenantSelector Component E2E Tests
 *
 * @tags @real-webauthn @e2e @tenant-selector @multi-tenancy
 *
 * Tests the TenantSelector dropdown component in both:
 * - Unauthenticated mode (login page): Redirects to tenant-specific login
 * - Authenticated mode (sidebar): Logs out and redirects to tenant login
 *
 * The TenantSelector derives known tenants from cachedUsers in localStorage.
 * To test it, we must first register users in multiple tenants.
 *
 * Prerequisites:
 *   SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   make test-real-webauthn
 */

import { test, expect, request } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clearBrowserStorage } from '../../helpers/browser-storage';
import {
  fetchBackendStatus,
  isWebSocketAvailable,
  getTransportDescription,
  clearStatusCache,
} from '../../helpers/backend-capabilities';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateTestTenantId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Helper to create a tenant via admin API
 */
async function createTenant(tenantId: string, displayName?: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
    data: { id: tenantId, name: displayName || `Test Tenant ${tenantId}`, display_name: displayName },
  });
  expect(response.ok()).toBe(true);
}

/**
 * Helper to delete a tenant via admin API
 */
async function deleteTenant(tenantId: string): Promise<void> {
  try {
    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    await adminApi.delete(`${ADMIN_URL}/admin/tenants/${tenantId}`);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Register a user via the frontend UI.
 * Robust version matching user-flows.spec.ts approach with error capturing.
 */
async function registerUserViaUI(
  page: Page,
  options: {
    username: string;
    tenantId?: string;
  }
): Promise<{ success: boolean; userId?: string; error?: string }> {
  const loginUrl = options.tenantId
    ? `${FRONTEND_URL}/id/${options.tenantId}/login`
    : `${FRONTEND_URL}/login`;

  console.log(`Navigating to: ${loginUrl}`);
  
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

  // If cached users are shown, click "Use other Account" first
  const useOtherAccount = page.locator('#useOtherAccount-switch-loginsignup, button:has-text("Use other Account")');
  if (await useOtherAccount.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('Found "Use other Account" button, clicking...');
    await useOtherAccount.click();
    await page.waitForTimeout(500);
  }

  // Switch to signup mode
  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('Found "Sign Up" button, clicking...');
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
    return { success: true, userId: finishResponse.uuid || finishResponse.user_id };
  }

  if (apiError) {
    return { success: false, error: apiError };
  }

  // Check if user appears in cached users (registration may have succeeded but redirect happened)
  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  const cachedUserButton = page.locator(`button:has-text("Log in as ${options.username}")`);
  if (await cachedUserButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    return { success: true, userId: 'cached-user-detected' };
  }

  return { success: false, error: 'No finish response captured and user not found in cache' };
}

/**
 * Login via UI using cached user button.
 * Robust version with error capturing.
 */
async function loginViaUI(
  page: Page,
  options: { tenantId?: string; cachedUserIndex?: number; username?: string } = {}
): Promise<{ success: boolean; error?: string }> {
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

  // Find cached user button - by username or index
  let cachedUserButton;
  if (options.username) {
    // Find button containing username text (more reliable than aria-label)
    cachedUserButton = page.locator(`button:has-text("${options.username}")`).first();
    console.log(`Looking for cached user button with username: ${options.username}`);
    const isVisible = await cachedUserButton.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`Button visible: ${isVisible}`);
  } else {
    const cachedIndex = options.cachedUserIndex ?? 0;
    cachedUserButton = page.locator(`#login-cached-user-${cachedIndex}-loginsignup`);
  }
  
  if (await cachedUserButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    const WEBAUTHN_TIMEOUT = 15000;
    
    try {
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('login-webauthn-finish'),
        { timeout: WEBAUTHN_TIMEOUT }
      );

      await cachedUserButton.click();
      
      // Race between response and timeout
      const result = await Promise.race([
        responsePromise.then(async (response) => {
          const status = response.status();
          const body = await response.json().catch(() => ({}));
          return { type: 'response' as const, status, body };
        }),
        page.waitForTimeout(WEBAUTHN_TIMEOUT).then(() => {
          return { type: 'timeout' as const };
        }),
      ]);

      if (result.type === 'timeout') {
        return { success: false, error: 'WebAuthn operation timed out - credential picker may be waiting' };
      }

      if (result.status === 200) {
        console.log(`Login successful: ${JSON.stringify(result.body)}`);
        return { success: true };
      }

      return { success: false, error: `Login failed with status ${result.status}: ${JSON.stringify(result.body)}` };
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
  }

  return { success: false, error: 'No cached user button found' };
}

/**
 * Wait for the wallet to be ready after login/registration.
 * Similar to credential-flow's waitForWalletReady.
 */
async function waitForWalletReady(page: Page): Promise<void> {
  const startTime = Date.now();
  const maxWait = 30000;

  while (Date.now() - startTime < maxWait) {
    const currentUrl = page.url();
    if (!currentUrl.includes('/login')) {
      await page.waitForTimeout(500);
      break;
    }

    const hasHomePage = await page.locator('[data-testid="home-page"], h1:has-text("My Wallet"), h1:has-text("Credentials")').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasHomePage) break;

    await page.waitForTimeout(500);
  }

  // Dismiss welcome dialog
  const dismissButton = page.locator('button:has-text("Dismiss")').first();
  if (await dismissButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('Dismissing welcome tour dialog...');
    await dismissButton.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Logout by clicking the sidebar logout button (proper UI logout)
 */
async function logoutViaSidebar(page: Page): Promise<void> {
  console.log('Logging out via sidebar...');
  
  // Debug: List buttons on page
  const buttons = await page.locator('button').all();
  const buttonInfo: string[] = [];
  for (const btn of buttons.slice(0, 10)) {
    const id = await btn.getAttribute('id').catch(() => '');
    const text = await btn.textContent().catch(() => '');
    if (id || text) buttonInfo.push(`${id || 'no-id'}:"${text?.trim().substring(0,20)}"`);
  }
  console.log(`Visible buttons: ${buttonInfo.join(', ')}`);

  // Try multiple logout selectors
  const logoutSelectors = [
    '#sidebar-item-logout',
    'button:has-text("Logout")',
    'button:has-text("Log out")',
    '[data-testid="logout"]',
    'nav button:last-child'
  ];

  for (const selector of logoutSelectors) {
    const btn = page.locator(selector).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`Found logout button with selector: ${selector}`);
      await btn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
      console.log(`After logout URL: ${page.url()}`);
      return;
    }
  }

  console.log('Logout button not found with any selector, clearing cookies');
  await page.context().clearCookies();
}

// =============================================================================
// TEST SUITES
// =============================================================================

test.describe.configure({ mode: 'serial' });

test.describe('Backend Capabilities', () => {
  test('detect available transport modes', async ({ request }) => {
    clearStatusCache();

    const status = await fetchBackendStatus(true);
    expect(status).not.toBeNull();

    const wsAvailable = await isWebSocketAvailable();
    const transportDesc = await getTransportDescription();

    console.log(`\n=== Backend Capabilities ===`);
    console.log(`Transport: ${transportDesc}`);
    console.log(`WebSocket available: ${wsAvailable}`);
    console.log(`============================\n`);
  });
});

test.describe('TenantSelector - Unauthenticated Mode (Login Page)', () => {
  let tenantA: string;
  let tenantB: string;

  test.beforeAll(async () => {
    tenantA = generateTestTenantId('selector-a');
    tenantB = generateTestTenantId('selector-b');
    await createTenant(tenantA, 'Tenant Alpha');
    await createTenant(tenantB, 'Tenant Beta');
    console.log(`Created tenants: ${tenantA}, ${tenantB}`);
  });

  test.afterAll(async () => {
    await deleteTenant(tenantA);
    await deleteTenant(tenantB);
    console.log(`Deleted tenants: ${tenantA}, ${tenantB}`);
  });

  test('TenantSelector should NOT appear when no users are cached', async ({ page }) => {
    // Clear all storage to ensure no cached users
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // TenantSelector should not be visible when there are no cached users
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).not.toBeVisible({ timeout: 3000 });
  });

  test('TenantSelector should NOT appear with only one tenant cached', async ({ page }) => {
    const userA = `user-a-${generateTestId()}`;

    // Capture page errors
    page.on('pageerror', (error) => {
      console.log(`[PAGE ERROR] ${error.message}`);
    });

    // Just navigate to login - don't clear storage, let Playwright's fresh context handle it
    // This matches credential-flow's approach
    console.log(`Registering ${userA}`);
    const result = await registerUserViaUI(page, { username: userA });
    expect(result.success).toBe(true);
    console.log(`✓ Registered user: ${result.userId}`);

    console.log(`After registration URL: ${page.url()}`);
    
    // Debug: Check page state IMMEDIATELY after registration
    await page.waitForTimeout(2000);
    console.log(`After 2s wait - URL: ${page.url()}`);
    const btnCountBeforeWait = await page.locator('button').count();
    console.log(`Buttons on page (before waitForWalletReady): ${btnCountBeforeWait}`);
    
    await waitForWalletReady(page);
    console.log(`After waitForWalletReady URL: ${page.url()}`);
    await logoutViaSidebar(page);

    // Navigate to login page
    console.log(`Navigating to: ${FRONTEND_URL}/login`);
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log(`After navigation URL: ${page.url()}`);

    // Check cached users in localStorage
    const cachedUsers = await page.evaluate(() => localStorage.getItem('cachedUsers'));
    console.log(`Cached users: ${cachedUsers}`);

    // Check page state
    const bodyHtml = await page.locator('body').innerHTML();
    console.log(`Body HTML length: ${bodyHtml.length}`);
    if (bodyHtml.length < 200) {
      console.log(`Body HTML: ${bodyHtml}`);
    }

    // Check if page renders
    const btnCount = await page.locator('button').count();
    console.log(`Single tenant test: button count: ${btnCount}`);
    expect(btnCount).toBeGreaterThan(0);

    // TenantSelector should not be visible when only one tenant
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).not.toBeVisible({ timeout: 3000 });
  });

  test('TenantSelector SHOULD appear with multiple tenants cached', async ({ page }) => {
    const userA = `user-a-${generateTestId()}`;
    const userB = `user-b-${generateTestId()}`;

    // Clear storage first
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    // Register user in Tenant A
    console.log(`Registering ${userA} in ${tenantA}`);
    const resultA = await registerUserViaUI(page, { username: userA, tenantId: tenantA });
    expect(resultA.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Register user in Tenant B
    console.log(`Registering ${userB} in ${tenantB}`);
    const resultB = await registerUserViaUI(page, { username: userB, tenantId: tenantB });
    expect(resultB.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Navigate to login page - both tenants should be cached
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Debug: Check cached users
    const cachedUsers = await page.evaluate(() => {
      const raw = localStorage.getItem('cachedUsers');
      return raw ? JSON.parse(raw) : null;
    });
    console.log('Cached Users count:', cachedUsers?.length);
    
    // Verify we have users from both tenants
    expect(cachedUsers).not.toBeNull();
    expect(cachedUsers.length).toBeGreaterThanOrEqual(2);
    
    const tenantIds = cachedUsers.map((u: any) => u.tenant?.id).filter(Boolean);
    console.log('Tenant IDs in cache:', tenantIds);
    expect(tenantIds).toContain(tenantA);
    expect(tenantIds).toContain(tenantB);

    // Page should have rendered
    const btnCount = await page.locator('button').count();
    console.log(`Button count: ${btnCount}`);
    expect(btnCount).toBeGreaterThan(0);

    // TenantSelector should be visible
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).toBeVisible({ timeout: 10000 });
  });

  test('TenantSelector shows available tenants and redirects', async ({ page }) => {
    const userA = `user-a-${generateTestId()}`;
    const userB = `user-b-${generateTestId()}`;

    // Clear storage and register users in both tenants
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    const resultA = await registerUserViaUI(page, { username: userA, tenantId: tenantA });
    expect(resultA.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    const resultB = await registerUserViaUI(page, { username: userB, tenantId: tenantB });
    expect(resultB.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Navigate to tenant A's login
    await page.goto(`${FRONTEND_URL}/id/${tenantA}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Verify select is visible (native <select> element)
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).toBeVisible({ timeout: 5000 });

    // Verify both options are available in the select
    const options = await tenantSelector.locator('option').all();
    expect(options.length).toBeGreaterThanOrEqual(2);

    // Get option text content
    const optionTexts = await Promise.all(options.map(o => o.textContent()));
    console.log('Available options:', optionTexts);
    expect(optionTexts.some(t => t?.includes('Alpha'))).toBe(true);
    expect(optionTexts.some(t => t?.includes('Beta'))).toBe(true);

    // Select Tenant B by value - should trigger redirect
    await tenantSelector.selectOption(tenantB);
    await page.waitForURL(`**/id/${tenantB}/login**`, { timeout: 5000 });
    expect(page.url()).toContain(`/id/${tenantB}/login`);
  });
});

test.describe('TenantSelector - Authenticated Mode (Sidebar)', () => {
  let tenantC: string;
  let tenantD: string;

  test.beforeAll(async () => {
    tenantC = generateTestTenantId('selector-c');
    tenantD = generateTestTenantId('selector-d');
    await createTenant(tenantC, 'Tenant Charlie');
    await createTenant(tenantD, 'Tenant Delta');
    console.log(`Created tenants: ${tenantC}, ${tenantD}`);
  });

  test.afterAll(async () => {
    await deleteTenant(tenantC);
    await deleteTenant(tenantD);
    console.log(`Deleted tenants: ${tenantC}, ${tenantD}`);
  });

  test('TenantSelector appears in sidebar when authenticated with multiple tenants', async ({ page }) => {
    const userC = `user-c-${generateTestId()}`;
    const userD = `user-d-${generateTestId()}`;

    // Clear storage and register users in both tenants
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    // Register user in Tenant C
    console.log(`Registering ${userC} in ${tenantC}`);
    const resultC = await registerUserViaUI(page, { username: userC, tenantId: tenantC });
    expect(resultC.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Register user in Tenant D
    console.log(`Registering ${userD} in ${tenantD}`);
    const resultD = await registerUserViaUI(page, { username: userD, tenantId: tenantD });
    expect(resultD.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Login to Tenant C as userC
    console.log(`Logging in as ${userC} to tenant ${tenantC}`);
    const loginResult = await loginViaUI(page, { tenantId: tenantC, username: userC });
    if (!loginResult.success) {
      console.log(`Login failed: ${loginResult.error}`);
    }
    expect(loginResult.success).toBe(true);
    await waitForWalletReady(page);

    // Wait for home page to load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // TenantSelector should be visible in sidebar
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).toBeVisible({ timeout: 5000 });

    // Verify select has options (native select doesn't need click to check)
    const options = await tenantSelector.locator('option').all();
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  test('Switching tenant from sidebar logs out and redirects', async ({ page }) => {
    const userC = `user-c-${generateTestId()}`;
    const userD = `user-d-${generateTestId()}`;

    // Clear storage and register users in both tenants
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    const resultC = await registerUserViaUI(page, { username: userC, tenantId: tenantC });
    expect(resultC.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    const resultD = await registerUserViaUI(page, { username: userD, tenantId: tenantD });
    expect(resultD.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Login to Tenant C as userC
    console.log(`Logging in as ${userC} to tenant ${tenantC}`);
    const loginResult = await loginViaUI(page, { tenantId: tenantC, username: userC });
    if (!loginResult.success) {
      console.log(`Login failed: ${loginResult.error}`);
    }
    expect(loginResult.success).toBe(true);
    await waitForWalletReady(page);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Verify we're on home page (authenticated)
    expect(page.url()).toContain(`/id/${tenantC}`);
    expect(page.url()).not.toContain('/login');

    // Select Tenant D (native select triggers redirect)
    const tenantSelector = page.locator('#tenant-selector');
    await tenantSelector.selectOption({ value: tenantD });

    // Should redirect to tenant D's login page (after logout)
    await page.waitForURL(`**/id/${tenantD}/login**`, { timeout: 10000 });
    expect(page.url()).toContain(`/id/${tenantD}/login`);

    // Should now be on login page (logged out) - use specific heading
    const loginHeading = page.getByRole('heading', { name: 'Welcome to wwWallet' });
    await expect(loginHeading).toBeVisible({ timeout: 5000 });
  });
});

test.describe('TenantSelector - Edge Cases', () => {
  let tenantE: string;

  test.beforeAll(async () => {
    tenantE = generateTestTenantId('selector-e');
    await createTenant(tenantE, 'Tenant Echo');
    console.log(`Created tenant: ${tenantE}`);
  });

  test.afterAll(async () => {
    await deleteTenant(tenantE);
    console.log(`Deleted tenant: ${tenantE}`);
  });

  test('TenantSelector hides when only current tenant is known', async ({ page }) => {
    const userE = `user-e-${generateTestId()}`;

    // Clear storage and register only in one tenant
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    // Register user
    const result = await registerUserViaUI(page, { username: userE, tenantId: tenantE });
    expect(result.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Go back to login page
    await page.goto(`${FRONTEND_URL}/id/${tenantE}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // TenantSelector should NOT be visible with only one tenant
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).not.toBeVisible({ timeout: 3000 });
  });

  test('Default tenant login page works after tenant selection', async ({ page }) => {
    const userE = `user-e-${generateTestId()}`;
    const defaultUser = `user-default-${generateTestId()}`;

    // Clear storage
    await page.goto(`${FRONTEND_URL}/login`);
    await clearBrowserStorage(page);

    // Register in tenant E first
    const resultE = await registerUserViaUI(page, { username: userE, tenantId: tenantE });
    expect(resultE.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Register in default tenant
    const result = await registerUserViaUI(page, { username: defaultUser });
    expect(result.success).toBe(true);
    await waitForWalletReady(page);
    await logoutViaSidebar(page);

    // Navigate to tenant E's login - should now see TenantSelector
    await page.goto(`${FRONTEND_URL}/id/${tenantE}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // TenantSelector should be visible with two tenants
    const tenantSelector = page.locator('#tenant-selector');
    await expect(tenantSelector).toBeVisible({ timeout: 5000 });

    // Verify options include default tenant (shown as "Default" for empty tenant ID)
    const options = await tenantSelector.locator('option').all();
    const optionTexts = await Promise.all(options.map(o => o.textContent()));
    console.log('Available options:', optionTexts);
    expect(optionTexts.some(t => t?.toLowerCase().includes('default'))).toBe(true);
  });

  // Note: "dropdown closes when clicking outside" test removed - 
  // Native <select> elements handle this behavior automatically via browser/OS
});
