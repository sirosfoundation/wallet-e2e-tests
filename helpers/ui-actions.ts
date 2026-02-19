/**
 * UI Action Helpers for Real WebAuthn E2E Tests
 *
 * Common UI interaction helpers used across WebAuthn test specs.
 * These helpers perform real browser interactions - no mocking.
 *
 * @module helpers/ui-actions
 */

import { expect, request } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Environment URLs - configurable via environment variables
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Export URLs for test usage
export { FRONTEND_URL, BACKEND_URL, ADMIN_URL, ADMIN_TOKEN };

/**
 * Generate a unique test identifier
 */
export function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique tenant ID with prefix
 */
export function generateTestTenantId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create a tenant via admin API
 */
export async function createTenant(tenantId: string, name?: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
    data: { id: tenantId, name: name || `Test Tenant ${tenantId}` },
  });
  expect(response.ok()).toBe(true);
}

/**
 * Delete a tenant via admin API (ignores errors)
 */
export async function deleteTenant(tenantId: string): Promise<void> {
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
 * Result from registerUserViaUI
 */
export interface RegisterResult {
  success: boolean;
  userId?: string;
  tenantId?: string;
  appToken?: string;
  error?: string;
}

/**
 * Options for registerUserViaUI
 */
export interface RegisterOptions {
  username: string;
  tenantId?: string;
}

/**
 * Register a new user via the frontend UI.
 *
 * This navigates to the signup page, fills in the username,
 * and clicks the signup button. The soft-fido2 authenticator
 * handles WebAuthn credential creation automatically.
 *
 * @param page - Playwright page
 * @param options - Registration options
 * @returns Registration result
 */
export async function registerUserViaUI(
  page: Page,
  options: RegisterOptions
): Promise<RegisterResult> {
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
 * Result from loginUserViaUI
 */
export interface LoginResult {
  success: boolean;
  userId?: string;
  tenantId?: string;
  redirectTenant?: string;
  error?: string;
  status?: number;
}

/**
 * Options for loginUserViaUI
 */
export interface LoginOptions {
  tenantId?: string;
  expectCachedUser?: boolean;
  cachedUserIndex?: number;
}

/**
 * Login a user via the frontend UI.
 *
 * This navigates to the login page and triggers login.
 * If there's a cached user, it clicks that user's login button.
 * Otherwise, it clicks the passkey login button.
 *
 * @param page - Playwright page
 * @param options - Login options
 * @returns Login result
 */
export async function loginUserViaUI(
  page: Page,
  options: LoginOptions = {}
): Promise<LoginResult> {
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
 * Capture endpoint paths called during a test.
 * Sets up route interception to capture which API paths are called.
 *
 * @param page - Playwright page
 * @param pattern - URL pattern to match
 * @returns Object with captured paths and stop function
 */
export async function captureEndpointPaths(
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
    stop: () => {
      page.unroute(pattern, handler);
    },
  };
}

/**
 * Wait for a specific URL to be reached.
 *
 * @param page - Playwright page
 * @param urlPattern - URL pattern to match (string or regex)
 * @param timeout - Timeout in milliseconds
 */
export async function waitForUrl(
  page: Page,
  urlPattern: string | RegExp,
  timeout: number = 10000
): Promise<void> {
  await page.waitForURL(urlPattern, { timeout });
}

/**
 * Check if user is authenticated by looking for dashboard elements.
 *
 * @param page - Playwright page
 * @returns True if user appears to be logged in
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  // Look for common indicators of authenticated state
  const indicators = [
    page.locator('[data-testid="dashboard"]'),
    page.locator('[data-testid="user-menu"]'),
    page.locator('text=Credentials'),
    page.locator('text=Home'),
  ];

  for (const indicator of indicators) {
    if (await indicator.isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }

  return false;
}

/**
 * Logout the current user.
 *
 * @param page - Playwright page
 */
export async function logoutUser(page: Page): Promise<void> {
  // Try to find and click logout button
  const logoutButton = page.locator('button:has-text("Logout"), button:has-text("Sign out")');
  if (await logoutButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await logoutButton.click();
    await page.waitForLoadState('networkidle');
  }
}
