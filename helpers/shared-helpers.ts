/**
 * Shared Helper Functions for WebAuthn E2E Tests
 * 
 * These helpers are used by both CDP and soft-fido2 test approaches.
 * Moving common functionality here eliminates duplication and ensures
 * both test tracks behave consistently.
 */

import { expect, request } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';

// =============================================================================
// Environment Configuration
// =============================================================================

export const ENV = {
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8080',
  ENGINE_URL: process.env.ENGINE_URL || 'http://localhost:8082',
  ADMIN_URL: process.env.ADMIN_URL || 'http://localhost:8081',
  ISSUER_URL: process.env.ISSUER_URL || 'http://localhost:9000',
  VERIFIER_URL: process.env.VERIFIER_URL || 'http://localhost:9001',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only',
};

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique test identifier
 */
export function generateTestId(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique tenant ID for testing
 */
export function generateTestTenantId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

// =============================================================================
// Tenant Management
// =============================================================================

/**
 * Create a tenant via admin API
 */
export async function createTenant(tenantId: string, name?: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ENV.ADMIN_URL}/admin/tenants`, {
    data: { id: tenantId, name: name || `Test Tenant ${tenantId}` },
  });
  expect(response.ok()).toBe(true);
  await adminApi.dispose();
}

/**
 * Delete a tenant via admin API
 */
export async function deleteTenant(tenantId: string): Promise<void> {
  try {
    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
    });
    await adminApi.delete(`${ENV.ADMIN_URL}/admin/tenants/${tenantId}`);
    await adminApi.dispose();
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Get tenant by ID
 */
export async function getTenant(tenantId: string): Promise<any | null> {
  try {
    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
    });
    const response = await adminApi.get(`${ENV.ADMIN_URL}/admin/tenants/${tenantId}`);
    if (response.ok()) {
      return await response.json();
    }
    await adminApi.dispose();
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Registration Result Types
// =============================================================================

export interface RegistrationResult {
  success: boolean;
  userId?: string;
  tenantId?: string;
  appToken?: string;
  error?: string;
}

export interface LoginResult {
  success: boolean;
  userId?: string;
  error?: string;
}

// =============================================================================
// UI Interaction Helpers
// =============================================================================

export interface RegisterOptions {
  username: string;
  tenantId?: string;
  /** Use security key (USB) instead of platform authenticator */
  useSecurityKey?: boolean;
  /** Timeout for WebAuthn operations in ms */
  timeout?: number;
}

export interface LoginOptions {
  username?: string;
  tenantId?: string;
  /** Timeout for WebAuthn operations in ms */
  timeout?: number;
}

/**
 * Navigate to the login page for a tenant
 */
export async function navigateToLogin(page: Page, tenantId?: string): Promise<void> {
  const loginUrl = tenantId
    ? `${ENV.FRONTEND_URL}/id/${tenantId}/login`
    : `${ENV.FRONTEND_URL}/login`;
  
  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}

/**
 * Switch to signup mode on the login page
 */
export async function switchToSignup(page: Page): Promise<boolean> {
  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signUpSwitch.click();
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/**
 * Fill the username field
 */
export async function fillUsername(page: Page, username: string): Promise<void> {
  const nameInput = page.locator('input[name="name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(username);
}

/**
 * Click the passkey signup button
 * @param useSecurityKey - If true, use security key button, otherwise platform
 */
export async function clickSignupButton(page: Page, useSecurityKey = false): Promise<void> {
  const buttonType = useSecurityKey ? 'security-key' : 'client-device';
  const signupButton = page.locator(`[id*="signUpPasskey"][id*="${buttonType}"][id*="submit"]`);
  
  if (await signupButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await signupButton.click();
  } else {
    // Fallback to any passkey button
    const anyPasskeyBtn = page.locator('[id*="signUpPasskey"][id*="submit"]').first();
    await expect(anyPasskeyBtn).toBeVisible({ timeout: 10000 });
    await anyPasskeyBtn.click();
  }
}

/**
 * Click the login button
 */
export async function clickLoginButton(page: Page): Promise<void> {
  const loginButton = page.locator('#logIn-submit').first();
  await expect(loginButton).toBeVisible({ timeout: 10000 });
  await loginButton.click();
}

/**
 * Handle PRF retry dialog if it appears
 */
export async function handlePrfRetryDialog(page: Page): Promise<boolean> {
  const continueButton = page.locator('button:has-text("Continue")');
  if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('PRF retry dialog detected, clicking Continue...');
    await continueButton.click();
    return true;
  }
  return false;
}

/**
 * Wait for registration finish response
 */
export async function waitForRegistrationFinish(
  page: Page,
  timeout = 20000
): Promise<{ response: any | null; error: string | null }> {
  let finishResponse: any = null;
  let apiError: string | null = null;

  const responseHandler = async (response: any) => {
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
  };

  page.on('response', responseHandler);

  try {
    await page.waitForResponse(
      (response) => response.url().includes('register-webauthn-finish'),
      { timeout }
    );
  } catch {
    // Timeout - check if we have error info
  }

  page.off('response', responseHandler);

  return { response: finishResponse, error: apiError };
}

/**
 * Wait for login finish response
 */
export async function waitForLoginFinish(
  page: Page,
  timeout = 20000
): Promise<{ response: any | null; error: string | null }> {
  let finishResponse: any = null;
  let apiError: string | null = null;

  const responseHandler = async (response: any) => {
    const url = response.url();
    if (url.includes('login-webauthn-finish') || url.includes('authenticate')) {
      try {
        const data = await response.json();
        if (response.status() === 200) {
          finishResponse = data;
        } else {
          apiError = data.error || `HTTP ${response.status()}`;
        }
      } catch {
        // Ignore
      }
    }
  };

  page.on('response', responseHandler);

  try {
    await page.waitForResponse(
      (response) => 
        response.url().includes('login-webauthn-finish') || 
        response.url().includes('authenticate'),
      { timeout }
    );
  } catch {
    // Timeout
  }

  page.off('response', responseHandler);

  return { response: finishResponse, error: apiError };
}

/**
 * Check if currently on login page
 */
export function isOnLoginPage(url: string): boolean {
  return url.includes('/login');
}

/**
 * Check if registration/login succeeded by URL
 */
export function hasNavigatedAway(url: string): boolean {
  return !url.includes('/login');
}
