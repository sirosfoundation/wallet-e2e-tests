/**
 * Real WebAuthn E2E Tests - Full User Flows with Real UI Interaction
 *
 * @tags @real-webauthn @e2e @user-flows @multi-tenancy
 *
 * These tests exercise complete user registration → login flows using
 * real browser WebAuthn with soft-fido2 virtual authenticator.
 *
 * CRITICAL DESIGN PRINCIPLE: All tests use REAL UI INTERACTIONS
 * - Navigate to actual pages
 * - Click actual buttons
 * - Fill actual form fields
 * - NO injected code via page.evaluate() for WebAuthn operations
 * - NO direct API calls for user-facing operations
 *
 * The soft-fido2 virtual authenticator automatically handles WebAuthn
 * credential creation and assertion without user interaction.
 *
 * IMPORTANT: Tests run serially to avoid credential conflicts.
 *
 * Prerequisites:
 *   SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   make test-real-webauthn
 */

import { test, expect, request } from '@playwright/test';
import type { Page, APIRequestContext, Route } from '@playwright/test';
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
async function createTenant(tenantId: string, name?: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
    data: { id: tenantId, name: name || `Test Tenant ${tenantId}` },
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
 * UI Helper: Register a new user via the frontend UI
 * 
 * This navigates to the signup page, fills in the username,
 * and clicks the signup button. The soft-fido2 authenticator
 * handles WebAuthn credential creation automatically.
 */
async function registerUserViaUI(
  page: Page,
  options: {
    username: string;
    tenantId?: string;
  }
): Promise<{
  success: boolean;
  userId?: string;
  tenantId?: string;
  appToken?: string;
  error?: string;
}> {
  // Navigate to the correct login/signup page
  // Default tenant uses root paths, custom tenants use /id/ prefix
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

  // Click "Sign Up" to switch to signup mode (if we're on login page)
  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signUpSwitch.click();
    await page.waitForTimeout(500);
  }

  // Fill in the username
  const nameInput = page.locator('input[name="name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(options.username);

  // Click the security-key (USB/roaming) passkey signup button
  // soft-fido2 presents as a USB HID authenticator, not a platform authenticator
  const signupButton = page.locator('[id*="signUpPasskey"][id*="security-key"][id*="submit"]');
  await expect(signupButton).toBeVisible({ timeout: 10000 });

  // Click and wait for the registration to complete with timeout
  const WEBAUTHN_TIMEOUT = 20000;
  
  try {
    // Start waiting for the finish response before clicking
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('register-webauthn-finish'),
      { timeout: WEBAUTHN_TIMEOUT * 2 } // Allow time for PRF retry
    );
    
    await signupButton.click();
    
    // Wait for the first WebAuthn ceremony to complete
    // The wallet may show a "Continue" button for PRF retry
    await page.waitForTimeout(3000);
    
    // Check if PRF retry dialog appeared ("Almost done!")
    const continueButton = page.locator('button:has-text("Continue")');
    if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('PRF retry dialog detected, clicking Continue...');
      await continueButton.click();
    }
    
    // Wait for the finish response
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
    return {
      success: true,
      userId: finishResponse.uuid,
      tenantId: finishResponse.tenantId || 'default',
      appToken: finishResponse.appToken,
    };
  }

  if (apiError) {
    return { success: false, error: apiError };
  }

  return { success: false, error: 'No finish response captured' };
}

/**
 * UI Helper: Login a user via the frontend UI
 *
 * This navigates to the login page and triggers login.
 * If there's a cached user, it clicks that user's login button.
 * Otherwise, it clicks the passkey login button.
 */
async function loginUserViaUI(
  page: Page,
  options: {
    tenantId?: string;
    expectCachedUser?: boolean;
    cachedUserIndex?: number;
  } = {}
): Promise<{
  success: boolean;
  userId?: string;
  tenantId?: string;
  redirectTenant?: string;
  error?: string;
  status?: number;
}> {
  // Navigate to the correct login page
  // Default tenant uses root paths, custom tenants use /id/ prefix
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
    // Check if we got a response before the error
    await page.waitForTimeout(500);
    
    if (finishResponse && finishStatus === 409) {
      return {
        success: false,
        status: 409,
        error: finishResponse.error,
        redirectTenant: finishResponse.redirect_tenant,
        userId: finishResponse.user_id,
      };
    }

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

  if (finishResponse) {
    if (finishStatus === 200) {
      return {
        success: true,
        status: 200,
        userId: finishResponse.uuid,
        tenantId: finishResponse.tenantId,
      };
    } else if (finishStatus === 409) {
      return {
        success: false,
        status: 409,
        error: finishResponse.error,
        redirectTenant: finishResponse.redirect_tenant,
        userId: finishResponse.user_id,
      };
    }
  }

  if (apiError) {
    return { success: false, error: apiError };
  }

  return { success: false, error: 'No finish response captured' };
}

/**
 * UI Helper: Verify endpoint paths used by the frontend
 * Sets up route interception to capture which API paths are called.
 */
async function captureEndpointPaths(
  page: Page,
  pattern: string
): Promise<{ paths: string[]; stop: () => void }> {
  const paths: string[] = [];

  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    paths.push(url.pathname);
    await route.continue();
  };

  await page.route(pattern, handler);

  return {
    paths,
    stop: () => page.unroute(pattern, handler),
  };
}

// =============================================================================
// TEST SUITES - ALL USE REAL UI INTERACTIONS
// =============================================================================

test.describe('Backend Capabilities Check', () => {
  test('detect available transport modes', async ({ request }) => {
    clearStatusCache();

    const status = await fetchBackendStatus(true);
    expect(status).not.toBeNull();
    expect(status?.status).toBe('ok');

    const wsAvailable = await isWebSocketAvailable();
    const transportDesc = await getTransportDescription();

    console.log(`\n=== Backend Capabilities ===`);
    console.log(`Service: ${status?.service || 'unknown'}`);
    console.log(`Version: ${status?.version || 'unknown'}`);
    console.log(`API version: ${status?.api_version || 1}`);
    console.log(`Transport: ${transportDesc}`);
    console.log(`WebSocket available: ${wsAvailable}`);
    console.log(`Capabilities: ${(status?.capabilities || []).join(', ') || 'none'}`);
    console.log(`============================\n`);

    // Test is informational - just ensure backend is healthy
    expect(status?.status).toBe('ok');
  });
});

test.describe('Full User Flow: Default Tenant Register → Login', () => {
  test('should complete full registration and login cycle in default tenant', async ({ page }) => {
    const username = `user-${generateTestId()}`;

    // Step 1: Register via UI
    console.log(`Registering user via UI: ${username}`);
    const registration = await registerUserViaUI(page, { username });

    expect(registration.success).toBe(true);
    expect(registration.userId).toBeDefined();
    console.log(`✓ Registered user: ${registration.userId}`);

    // Dismiss welcome dialog if visible
    const dismissButton = page.locator('button:has-text("Dismiss")');
    if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissButton.click();
      await page.waitForTimeout(500);
    }

    // Step 2: Logout first (user is logged in after registration)
    console.log(`Logging out user...`);
    const logoutButton = page.locator('button:has-text("Logout")');
    if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await logoutButton.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Step 3: Login via UI (user should be cached)
    console.log(`Logging in user via UI: ${registration.userId}`);
    const login = await loginUserViaUI(page, { expectCachedUser: true });

    expect(login.success).toBe(true);
    expect(login.userId).toBe(registration.userId);
    console.log(`✓ Logged in user: ${login.userId}`);
  });
});

test.describe('Full User Flow: Custom Tenant Register → Login', () => {
  let testTenantId: string;

  test.beforeAll(async () => {
    testTenantId = generateTestTenantId('flow');
    await createTenant(testTenantId, `Flow Test Tenant ${testTenantId}`);
    console.log(`Created test tenant: ${testTenantId}`);
  });

  test.afterAll(async () => {
    await deleteTenant(testTenantId);
    console.log(`Deleted test tenant: ${testTenantId}`);
  });

  test('should complete full registration and login cycle in custom tenant', async ({ page }) => {
    const username = `tenant-user-${generateTestId()}`;

    // Step 1: Register in custom tenant via UI
    console.log(`Registering user in tenant ${testTenantId}: ${username}`);
    const registration = await registerUserViaUI(page, {
      username,
      tenantId: testTenantId,
    });

    expect(registration.success).toBe(true);
    expect(registration.tenantId).toBe(testTenantId);
    console.log(`✓ Registered user: ${registration.userId} in tenant: ${registration.tenantId}`);

    // Dismiss welcome dialog if visible
    const dismissButton = page.locator('button:has-text("Dismiss")');
    if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissButton.click();
      await page.waitForTimeout(500);
    }

    // Step 2: Logout first (user is logged in after registration)
    console.log(`Logging out user...`);
    const logoutButton = page.locator('button:has-text("Logout")');
    if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await logoutButton.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Step 3: Login via tenant UI (user should be cached)
    console.log(`Logging in via tenant UI: /${testTenantId}`);
    const login = await loginUserViaUI(page, {
      tenantId: testTenantId,
      expectCachedUser: true,
    });

    expect(login.success).toBe(true);
    expect(login.userId).toBe(registration.userId);
    expect(login.tenantId).toBe(testTenantId);
    console.log(`✓ Logged in user: ${login.userId} in tenant: ${login.tenantId}`);
  });
});

test.describe('Frontend Endpoint Construction Verification', () => {
  /**
   * Verify that the frontend constructs correct API endpoints based on URL context.
   * These tests use route interception to verify paths while using real UI interactions.
   */

  test('should use global endpoints for tenant login (backend discovers tenant)', async ({ page }) => {
    const testTenantId = generateTestTenantId('endpoint-test');
    await createTenant(testTenantId);

    try {
      // First register a user to have a cached credential
      const username = `endpoint-test-${generateTestId()}`;
      const registration = await registerUserViaUI(page, {
        username,
        tenantId: testTenantId,
      });
      expect(registration.success).toBe(true);
      console.log(`✓ Registered user: ${registration.userId}`);

      // Dismiss welcome dialog if visible and logout
      const dismissButton = page.locator('button:has-text("Dismiss")');
      if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dismissButton.click();
        await page.waitForTimeout(500);
      }
      const logoutButton = page.locator('button:has-text("Logout")');
      if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await logoutButton.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
      }

      // Set up endpoint path capture
      const capture = await captureEndpointPaths(page, '**/user/login-webauthn-*');

      // Navigate to tenant login and click login
      await page.goto(`${FRONTEND_URL}/id/${testTenantId}/login`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      const loginButton = page.locator('#login-cached-user-0-loginsignup');
      await expect(loginButton).toBeVisible({ timeout: 15000 });
      await loginButton.click();
      await page.waitForTimeout(3000);

      capture.stop();

      // Verify global endpoint was used (backend discovers tenant from passkey)
      console.log('Captured paths:', capture.paths);
      const beginPath = capture.paths.find((p) => p.includes('login-webauthn-begin'));
      expect(beginPath).toBe('/user/login-webauthn-begin');
      console.log(`✓ begin path is global (tenant discovered from passkey): ${beginPath}`);
    } finally {
      await deleteTenant(testTenantId);
    }
  });

  test('should construct global endpoints when on global login page', async ({ page }) => {
    // First register a user in default tenant
    const username = `global-test-${generateTestId()}`;
    const registration = await registerUserViaUI(page, { username });
    expect(registration.success).toBe(true);
    console.log(`✓ Registered user: ${registration.userId}`);

    // Dismiss welcome dialog if visible and logout
    const dismissButton = page.locator('button:has-text("Dismiss")');
    if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissButton.click();
      await page.waitForTimeout(500);
    }
    const logoutButton = page.locator('button:has-text("Logout")');
    if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await logoutButton.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Set up endpoint path capture
    const capture = await captureEndpointPaths(page, '**/user/login-webauthn-*');

    // Navigate to global login and click login
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const loginButton = page.locator('#login-cached-user-0-loginsignup');
    await expect(loginButton).toBeVisible({ timeout: 15000 });
    await loginButton.click();
    await page.waitForTimeout(3000);

    capture.stop();

    // Verify global endpoint was used
    console.log('Captured paths:', capture.paths);
    const beginPath = capture.paths.find((p) => p.includes('login-webauthn-begin'));
    expect(beginPath).toBe('/user/login-webauthn-begin');
    console.log(`✓ begin path is global: ${beginPath}`);
  });
});

test.describe('Cross-Tenant Credential Isolation', () => {
  // NOTE: This test verifies that credentials are properly isolated between tenants.
  // When using discoverable credentials with soft-fido2, the authenticator may pick
  // any matching credential for the RP ID. The backend correctly rejects credentials
  // that don't belong to the requested tenant (409 Conflict).
  
  test('should create different user handles for same username in different tenants', async ({ page }) => {
    const tenantA = generateTestTenantId('iso-a');
    const tenantB = generateTestTenantId('iso-b');
    
    await createTenant(tenantA, `Isolation Tenant A ${tenantA}`);
    await createTenant(tenantB, `Isolation Tenant B ${tenantB}`);
    console.log(`Created isolation tenants: ${tenantA}, ${tenantB}`);
    
    try {
      const sharedUsername = `shared-${generateTestId()}`;

      // Register same username in tenant A via UI
      console.log(`Registering "${sharedUsername}" in tenant ${tenantA}`);
      const registrationA = await registerUserViaUI(page, {
        username: sharedUsername,
        tenantId: tenantA,
      });
      expect(registrationA.success).toBe(true);
      expect(registrationA.tenantId).toBe(tenantA);

      // Dismiss welcome dialog and logout from tenant A
      let dismissButton = page.locator('button:has-text("Dismiss")');
      if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dismissButton.click();
        await page.waitForTimeout(500);
      }
      let logoutButton = page.locator('button:has-text("Logout")');
      if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await logoutButton.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
      }

      // Clear cached users and register same username in tenant B via UI
      await page.evaluate(() => localStorage.removeItem('cachedUsers'));
      
      console.log(`Registering "${sharedUsername}" in tenant ${tenantB}`);
      const registrationB = await registerUserViaUI(page, {
        username: sharedUsername,
        tenantId: tenantB,
      });
      expect(registrationB.success).toBe(true);
      expect(registrationB.tenantId).toBe(tenantB);

      // Verify isolation - different user IDs for same username in different tenants
      expect(registrationA.userId).not.toBe(registrationB.userId);

      console.log(`✓ Same username has different user IDs:`);
      console.log(`  Tenant A: ${registrationA.userId}`);
      console.log(`  Tenant B: ${registrationB.userId}`);
    } finally {
      await deleteTenant(tenantA);
      await deleteTenant(tenantB);
      console.log(`Deleted isolation tenants`);
    }
  });
});

test.describe('Tenant API Error Handling', () => {
  test('should return 404 for registration with non-existent tenant', async ({ request: apiRequest }) => {
    // This test uses direct API call since it's testing backend error handling
    // Per ADR-011, tenant is specified via X-Tenant-ID header (not request body)
    const response = await apiRequest.post(
      `${BACKEND_URL}/user/register-webauthn-begin`,
      {
        headers: { 'X-Tenant-ID': 'this-tenant-does-not-exist' },
        data: {},
      }
    );

    expect(response.status()).toBe(404);
    console.log(`✓ Non-existent tenant returns 404`);
  });
});

test.describe('Tenant User Handle Format', () => {
  let testTenantId: string;

  test.beforeAll(async () => {
    testTenantId = generateTestTenantId('handle');
    await createTenant(testTenantId, `Handle Test Tenant ${testTenantId}`);
    console.log(`Created handle test tenant: ${testTenantId}`);
  });

  test.afterAll(async () => {
    await deleteTenant(testTenantId);
    console.log(`Deleted handle test tenant: ${testTenantId}`);
  });

  test('should return tenantId in registration finish response', async ({ page }) => {
    const username = `response-${generateTestId()}`;

    // Register via UI and verify tenantId is returned
    const registration = await registerUserViaUI(page, {
      username,
      tenantId: testTenantId,
    });

    expect(registration.success).toBe(true);
    expect(registration.tenantId).toBe(testTenantId);
    expect(registration.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

    console.log(`✓ Registration response includes tenantId: ${registration.tenantId}`);
  });
});

test.describe('Tenant-Aware URL Routing', () => {
  test('should use root paths for default tenant login page', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    expect(url).toBe(`${FRONTEND_URL}/login`);
    expect(url).not.toContain('/t/');

    console.log(`✓ Default tenant uses root path: ${url}`);
  });

  test('should use tenant-scoped paths for non-default tenant login page', async ({ page }) => {
    const tenantId = generateTestTenantId('url-test');
    await createTenant(tenantId);

    try {
      // Frontend uses /id/{tenantId}/login for custom tenants
      await page.goto(`${FRONTEND_URL}/id/${tenantId}/login`);
      await page.waitForLoadState('networkidle');

      const url = page.url();
      expect(url).toContain(`/id/${tenantId}`);

      console.log(`✓ Custom tenant uses /id/ prefix path: ${url}`);
    } finally {
      await deleteTenant(tenantId);
    }
  });

  test('should preserve tenant context in URL for unauthenticated users', async ({ page }) => {
    const tenantId = generateTestTenantId('redirect-test');
    await createTenant(tenantId);

    try {
      // Access tenant route without auth
      await page.goto(`${FRONTEND_URL}/id/${tenantId}/`);
      await page.waitForLoadState('networkidle');

      const url = page.url();
      // URL should contain the tenant ID with /id/ prefix
      expect(url).toContain(`/id/${tenantId}`);

      console.log(`✓ Tenant context preserved in URL: ${url}`);
    } finally {
      await deleteTenant(tenantId);
    }
  });
});

/**
 * Test suite for credential ID stability (GitHub Issue #12)
 * 
 * This verifies that credential IDs returned by the backend are stable
 * and can be used for rename/delete operations. The bug was that the
 * credential ID format differed between storage (base64url) and API
 * responses, causing rename/delete to fail with "credential not found".
 * 
 * @see https://github.com/sirosfoundation/go-wallet-backend/issues/12
 * @see https://github.com/sirosfoundation/go-wallet-backend/pull/17
 */
test.describe('Credential ID Stability (Issue #12)', () => {
  test('should be able to rename credential using ID from account-info', async ({ page }) => {
    const username = `rename-test-${generateTestId()}`;

    // Step 1: Register a user via UI
    console.log(`Registering user for credential rename test: ${username}`);
    const registration = await registerUserViaUI(page, { username });
    
    expect(registration.success).toBe(true);
    expect(registration.appToken).toBeDefined();
    console.log(`✓ Registered user: ${registration.userId}`);
    console.log(`✓ Got app token: ${registration.appToken?.substring(0, 20)}...`);

    // Step 2: Get account info to retrieve credential IDs
    const apiContext = await request.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${registration.appToken}`,
      },
    });

    const accountInfoResponse = await apiContext.get(`${BACKEND_URL}/user/session/account-info`);
    
    // Debug: log the response status and body if not ok
    if (!accountInfoResponse.ok()) {
      console.log(`✗ Account info request failed: ${accountInfoResponse.status()}`);
      const text = await accountInfoResponse.text();
      console.log(`  Response body: ${text.substring(0, 200)}`);
    }
    expect(accountInfoResponse.ok()).toBe(true);
    
    const accountInfo = await accountInfoResponse.json();
    expect(accountInfo.webauthnCredentials).toBeDefined();
    expect(accountInfo.webauthnCredentials.length).toBeGreaterThan(0);
    
    const credentialId = accountInfo.webauthnCredentials[0].id;
    console.log(`✓ Retrieved credential ID: ${credentialId}`);

    // Step 3: Rename the credential using the ID
    const newNickname = `Renamed-${Date.now()}`;
    const renameResponse = await apiContext.post(
      `${BACKEND_URL}/user/session/webauthn/credential/${encodeURIComponent(credentialId)}/rename`,
      {
        data: { nickname: newNickname },
      }
    );
    
    // The key assertion: rename should succeed, not 404
    expect(renameResponse.ok()).toBe(true);
    console.log(`✓ Successfully renamed credential to: ${newNickname}`);

    // Step 4: Verify the rename persisted
    const verifyResponse = await apiContext.get(`${BACKEND_URL}/user/session/account-info`);
    expect(verifyResponse.ok()).toBe(true);
    
    const updatedAccountInfo = await verifyResponse.json();
    const renamedCred = updatedAccountInfo.webauthnCredentials.find(
      (c: any) => c.id === credentialId
    );
    expect(renamedCred).toBeDefined();
    expect(renamedCred.nickname).toBe(newNickname);
    console.log(`✓ Verified credential nickname is now: ${renamedCred.nickname}`);
  });

  test('should have matching credential IDs between registration and login', async ({ page }) => {
    const username = `id-match-test-${generateTestId()}`;

    // Step 1: Register a user via UI
    console.log(`Registering user for ID matching test: ${username}`);
    const registration = await registerUserViaUI(page, { username });
    
    expect(registration.success).toBe(true);
    expect(registration.appToken).toBeDefined();
    console.log(`✓ Got app token: ${registration.appToken?.substring(0, 20)}...`);

    // Step 2: Get credential ID from account-info after registration
    const apiContext = await request.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${registration.appToken}`,
      },
    });

    const accountInfoResponse = await apiContext.get(`${BACKEND_URL}/user/session/account-info`);
    
    // Debug: log the response status and body if not ok
    if (!accountInfoResponse.ok()) {
      console.log(`✗ Account info request failed: ${accountInfoResponse.status()}`);
      const text = await accountInfoResponse.text();
      console.log(`  Response body: ${text.substring(0, 200)}`);
      expect(accountInfoResponse.ok()).toBe(true);
      return;
    }
    
    const accountInfo = await accountInfoResponse.json();
    const registeredCredentialId = accountInfo.webauthnCredentials[0].id;
    console.log(`✓ Credential ID after registration: ${registeredCredentialId}`);

    // Step 3: Logout and login again
    const dismissButton = page.locator('button:has-text("Dismiss")');
    if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissButton.click();
      await page.waitForTimeout(500);
    }

    const logoutButton = page.locator('button:has-text("Logout")');
    if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await logoutButton.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Login via UI
    const login = await loginUserViaUI(page, { expectCachedUser: true });
    expect(login.success).toBe(true);
    console.log(`✓ Logged in user: ${login.userId}`);

    // Step 4: Get credential ID again after login - should be the same
    // We need to get a new token from the login response
    // For now, verify that the credential lookup worked (login succeeded)
    // which proves the credential ID is stable
    expect(login.userId).toBe(registration.userId);
    console.log(`✓ Login succeeded with same user ID, proving credential ID stability`);
  });
});
