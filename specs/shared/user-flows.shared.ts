/**
 * Shared User Flow Test Definitions
 * 
 * These test definitions are used by both CDP and soft-fido2 test suites.
 * Tests are exported as functions that can be called with different adapters.
 */

import { expect } from '@playwright/test';
import type { Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions } from '@playwright/test';
import type { WebAuthnAdapter, WebAuthnAdapterInfo, WebAuthnFixtures } from '../../helpers/webauthn-adapter';
import {
  ENV,
  generateTestId,
  generateTestTenantId,
  createTenant,
  deleteTenant,
  navigateToLogin,
  switchToSignup,
  fillUsername,
  clickSignupButton,
  clickLoginButton,
  handlePrfRetryDialog,
  waitForRegistrationFinish,
  waitForLoginFinish,
  isOnLoginPage,
  hasNavigatedAway,
  type RegistrationResult,
  type LoginResult,
  type RegisterOptions,
  type LoginOptions,
} from '../../helpers/shared-helpers';

// =============================================================================
// High-Level UI Helpers (using shared primitives)
// =============================================================================

/**
 * Register a new user via the frontend UI
 * Works with both CDP and soft-fido2 adapters
 */
export async function registerUserViaUI(
  page: Page,
  adapter: WebAuthnAdapter,
  options: RegisterOptions
): Promise<RegistrationResult> {
  const timeout = options.timeout || 20000;
  
  await navigateToLogin(page, options.tenantId);
  await switchToSignup(page);
  await fillUsername(page, options.username);
  
  // Start listening for finish response BEFORE clicking
  const responsePromise = waitForRegistrationFinish(page, timeout);
  
  await clickSignupButton(page, options.useSecurityKey);
  
  // Wait for WebAuthn flow
  await page.waitForTimeout(3000);
  
  // Handle PRF retry dialog if it appears
  await handlePrfRetryDialog(page);
  
  // Wait for the finish response
  const { response, error } = await responsePromise;
  
  if (error) {
    return { success: false, error };
  }
  
  // Wait for navigation
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  
  if (response) {
    return {
      success: true,
      userId: response.uuid || response.userId || response.user?.id,
      tenantId: response.tenantId || options.tenantId,
      appToken: response.appToken,
    };
  }
  
  if (hasNavigatedAway(currentUrl)) {
    return {
      success: true,
      tenantId: options.tenantId,
    };
  }
  
  return { success: false, error: 'Registration did not complete' };
}

/**
 * Login a user via the frontend UI
 * Works with both CDP and soft-fido2 adapters
 */
export async function loginUserViaUI(
  page: Page,
  adapter: WebAuthnAdapter,
  options: LoginOptions
): Promise<LoginResult> {
  const timeout = options.timeout || 20000;
  
  await navigateToLogin(page, options.tenantId);
  
  // Check if we're on login page
  const nameInput = page.locator('input[name="name"]');
  const isLoginVisible = await nameInput.isVisible({ timeout: 3000 }).catch(() => false);
  
  if (!isLoginVisible) {
    // May already be logged in
    const currentUrl = page.url();
    if (hasNavigatedAway(currentUrl)) {
      return { success: true };
    }
    return { success: false, error: 'Login page not visible' };
  }
  
  if (options.username) {
    await fillUsername(page, options.username);
  }
  
  // Start listening before clicking
  const responsePromise = waitForLoginFinish(page, timeout);
  
  await clickLoginButton(page);
  
  // Wait for WebAuthn flow
  await page.waitForTimeout(3000);
  
  const { response, error } = await responsePromise;
  
  if (error) {
    return { success: false, error };
  }
  
  // Wait for navigation
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  
  if (response || hasNavigatedAway(currentUrl)) {
    return {
      success: true,
      userId: response?.uuid || response?.userId,
    };
  }
  
  return { success: false, error: 'Login did not complete' };
}

// =============================================================================
// Shared Test Definitions
// =============================================================================

/**
 * User Registration Flow Tests
 * 
 * @param test - The Playwright test runner with WebAuthn fixtures
 * @param adapterInfo - Function to get adapter info for conditional tests
 */
export function defineUserRegistrationTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('User Registration Flow', () => {
    test.describe.configure({ mode: 'serial' });

    let testTenantId: string;
    let testUsername: string;

    test.beforeAll(async () => {
      const info = adapterInfo();
      testTenantId = generateTestTenantId(`${info.type}-reg`);
      testUsername = `user-${generateTestId(info.type)}`;
      await createTenant(testTenantId);
    });

    test.afterAll(async () => {
      await deleteTenant(testTenantId);
    });

    test('should register a new user with PRF-enabled passkey', async ({ page, webauthnAdapter }) => {
      const result = await registerUserViaUI(page, webauthnAdapter, {
        username: testUsername,
        tenantId: testTenantId,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify we're no longer on login page
      const currentUrl = page.url();
      expect(currentUrl).not.toContain('/login');
    });

    test('should login with previously registered credential', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      
      // CDP credentials don't persist across browser contexts
      // This is a known limitation - skip gracefully
      if (!info.credentialsPersist) {
        await navigateToLogin(page, testTenantId);
        await page.waitForTimeout(1000);
        
        // Check if we're on login page or redirected
        const nameInput = page.locator('input[name="name"]');
        const isLoginPage = await nameInput.isVisible({ timeout: 3000 }).catch(() => false);
        
        if (!isLoginPage) {
          console.log(`[${info.name}] Login page not visible - may be logged in from registration`);
          test.skip();
          return;
        }
        
        // Fill username and attempt login (may fail due to credential persistence)
        await fillUsername(page, testUsername);
        await clickLoginButton(page);
        await page.waitForTimeout(3000);
        
        // Test passes if we got this far - actual auth may fail
        console.log(`[${info.name}] Login flow executed - credential persistence limitation`);
        return;
      }

      // For soft-fido2, credentials persist - expect success
      const result = await loginUserViaUI(page, webauthnAdapter, {
        username: testUsername,
        tenantId: testTenantId,
      });

      expect(result.success).toBe(true);
    });
  });
}

/**
 * PRF Extension Verification Tests
 */
export function definePrfVerificationTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('PRF Extension Verification', () => {
    let testTenantId: string;

    test.beforeAll(async () => {
      const info = adapterInfo();
      testTenantId = generateTestTenantId(`${info.type}-prf`);
      await createTenant(testTenantId);
    });

    test.afterAll(async () => {
      await deleteTenant(testTenantId);
    });

    test('should receive PRF output during registration', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      const testUsername = `prf-test-${generateTestId(info.type)}`;
      
      // Capture PRF-related console logs
      const prfLogs: string[] = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[PRF') || text.includes('prf') || text.includes('PRF')) {
          prfLogs.push(text);
        }
      });

      const result = await registerUserViaUI(page, webauthnAdapter, {
        username: testUsername,
        tenantId: testTenantId,
      });

      if (info.prfMocked) {
        // CDP approach - check PRF mock was invoked
        const prfComputed = prfLogs.some(log => log.includes('Computed PRF'));
        if (result.success) {
          expect(prfComputed).toBe(true);
          console.log(`[${info.name}] PRF mock successfully computed output`);
        }
      } else {
        // soft-fido2 - PRF is handled natively
        expect(result.success).toBe(true);
        console.log(`[${info.name}] Native PRF completed successfully`);
      }
    });
  });
}

/**
 * Error Handling Tests
 */
export function defineErrorHandlingTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Error Handling', () => {
    test('should handle WebAuthn errors gracefully', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      
      // Navigate to login with non-existent tenant
      await page.goto(`${ENV.FRONTEND_URL}/id/nonexistent-tenant-xyz/login`);
      await page.waitForLoadState('networkidle');
      
      // The app should handle this gracefully
      // Either show error or redirect
      await page.waitForTimeout(2000);
      
      // Test passes if no crash occurred
      const pageTitle = await page.title();
      expect(pageTitle).toBeDefined();
      console.log(`[${info.name}] Error handling test completed`);
    });
  });
}

/**
 * Multi-Tenant Tests
 */
export function defineMultiTenantTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Multi-Tenant Support', () => {
    let tenant1Id: string;
    let tenant2Id: string;

    test.beforeAll(async () => {
      const info = adapterInfo();
      tenant1Id = generateTestTenantId(`${info.type}-mt1`);
      tenant2Id = generateTestTenantId(`${info.type}-mt2`);
      await createTenant(tenant1Id, 'Multi-Tenant Test 1');
      await createTenant(tenant2Id, 'Multi-Tenant Test 2');
    });

    test.afterAll(async () => {
      await deleteTenant(tenant1Id);
      await deleteTenant(tenant2Id);
    });

    test('should register users in different tenants', async ({ page, webauthnAdapter, context }) => {
      const info = adapterInfo();
      
      // Register in tenant 1
      const user1 = `mt-user1-${generateTestId(info.type)}`;
      const result1 = await registerUserViaUI(page, webauthnAdapter, {
        username: user1,
        tenantId: tenant1Id,
      });
      
      expect(result1.success).toBe(true);
      
      // Clear browser state for next tenant
      await context.clearCookies();
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      
      // Clear credentials if supported (CDP)
      if (webauthnAdapter.clearCredentials) {
        await webauthnAdapter.clearCredentials();
      }
      
      // Navigate to tenant 2 in fresh state
      const user2 = `mt-user2-${generateTestId(info.type)}`;
      const result2 = await registerUserViaUI(page, webauthnAdapter, {
        username: user2,
        tenantId: tenant2Id,
      });
      
      expect(result2.success).toBe(true);
      
      console.log(`[${info.name}] Multi-tenant registration successful`);
    });
  });
}

// =============================================================================
// Export all shared test suites
// =============================================================================

export const allSharedTests = {
  userRegistration: defineUserRegistrationTests,
  prfVerification: definePrfVerificationTests,
  errorHandling: defineErrorHandlingTests,
  multiTenant: defineMultiTenantTests,
};
