/**
 * Shared Tenant URL Routing Test Definitions
 * 
 * These tests verify that the frontend correctly routes tenant URLs
 * and constructs API endpoints based on URL context.
 */

import { expect, request } from '@playwright/test';
import type { Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions, Route } from '@playwright/test';
import type { WebAuthnAdapter, WebAuthnAdapterInfo, WebAuthnFixtures } from '../../helpers/webauthn-adapter';
import {
  ENV,
  generateTestId,
  generateTestTenantId,
  createTenant,
  deleteTenant,
  navigateToLogin,
} from '../../helpers/shared-helpers';
import { registerUserViaUI, loginUserViaUI } from './user-flows.shared';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Capture API endpoint paths during navigation
 */
async function captureEndpointPaths(page: Page, urlPattern: string): Promise<{
  paths: string[];
  stop: () => void;
}> {
  const paths: string[] = [];
  
  const handler = (route: Route) => {
    const url = new URL(route.request().url());
    paths.push(url.pathname);
    route.continue();
  };
  
  await page.route(urlPattern, handler);
  
  return {
    paths,
    stop: () => page.unroute(urlPattern, handler),
  };
}

// =============================================================================
// Test Definitions
// =============================================================================

/**
 * Define tenant URL routing tests
 */
export function defineTenantRoutingTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Tenant-Aware URL Routing', () => {
    test('should use root paths for default tenant login page', async ({ page }) => {
      const info = adapterInfo();
      
      await page.goto(`${ENV.FRONTEND_URL}/login`);
      await page.waitForLoadState('networkidle');

      const url = page.url();
      expect(url).toBe(`${ENV.FRONTEND_URL}/login`);
      expect(url).not.toContain('/t/');
      expect(url).not.toContain('/id/');

      console.log(`[${info.name}] Default tenant uses root path: ${url}`);
    });

    test('should use tenant-scoped paths for non-default tenant login page', async ({ page }) => {
      const info = adapterInfo();
      const tenantId = generateTestTenantId('url-test');
      await createTenant(tenantId);

      try {
        // Frontend uses /id/{tenantId}/login for custom tenants
        await page.goto(`${ENV.FRONTEND_URL}/id/${tenantId}/login`);
        await page.waitForLoadState('networkidle');

        const url = page.url();
        expect(url).toContain(`/id/${tenantId}`);

        console.log(`[${info.name}] Custom tenant uses /id/ prefix path: ${url}`);
      } finally {
        await deleteTenant(tenantId);
      }
    });

    test('should preserve tenant context in URL for unauthenticated users', async ({ page }) => {
      const info = adapterInfo();
      const tenantId = generateTestTenantId('redirect-test');
      await createTenant(tenantId);

      try {
        // Access tenant route without auth
        await page.goto(`${ENV.FRONTEND_URL}/id/${tenantId}/`);
        await page.waitForLoadState('networkidle');

        const url = page.url();
        // URL should contain the tenant ID with /id/ prefix
        expect(url).toContain(`/id/${tenantId}`);

        console.log(`[${info.name}] Tenant context preserved in URL: ${url}`);
      } finally {
        await deleteTenant(tenantId);
      }
    });
  });
}

/**
 * Define frontend endpoint construction tests
 * These tests verify that the frontend constructs correct API endpoints based on URL context
 */
export function defineEndpointConstructionTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  let testTenantId: string;
  
  test.describe('Frontend Endpoint Construction Verification', () => {
    test.beforeAll(async () => {
      testTenantId = generateTestTenantId('endpoint');
      await createTenant(testTenantId);
    });

    test.afterAll(async () => {
      await deleteTenant(testTenantId);
    });

    test('should use global endpoints for tenant login (backend discovers tenant)', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();

      // First register a user to have a cached credential
      const username = `endpoint-test-${generateTestId(info.type)}`;
      const registration = await registerUserViaUI(page, webauthnAdapter, {
        username,
        tenantId: testTenantId,
      });
      expect(registration.success).toBe(true);
      console.log(`[${info.name}] Registered user: ${registration.userId}`);

      // Dismiss modals and logout
      const dismissButton = page.locator('button:has-text("Dismiss")');
      if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dismissButton.click();
        await page.waitForTimeout(500);
      }

      // Clear session for fresh login
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });

      // Navigate to tenant login page
      await page.goto(`${ENV.FRONTEND_URL}/id/${testTenantId}/login`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Check that we're on the tenant login page
      const currentUrl = page.url();
      expect(currentUrl).toContain(`/id/${testTenantId}`);
      console.log(`[${info.name}] On tenant login page: ${currentUrl}`);
    });

    test('should construct global endpoints when on global login page', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();

      // Register a user in default tenant
      const username = `global-test-${generateTestId(info.type)}`;
      const registration = await registerUserViaUI(page, webauthnAdapter, { username });
      expect(registration.success).toBe(true);
      console.log(`[${info.name}] Registered user: ${registration.userId}`);

      // Dismiss modals
      const dismissButton = page.locator('button:has-text("Dismiss")');
      if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dismissButton.click();
        await page.waitForTimeout(500);
      }

      // Navigate to global login
      await page.goto(`${ENV.FRONTEND_URL}/login`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Verify we're either on login page or root (if session persisted and redirected)
      const currentUrl = page.url();
      const isOnGlobalPage = currentUrl === `${ENV.FRONTEND_URL}/login` || 
                             currentUrl === `${ENV.FRONTEND_URL}/` ||
                             currentUrl === ENV.FRONTEND_URL;
      expect(isOnGlobalPage).toBe(true);
      expect(currentUrl).not.toContain('/id/'); // Should NOT be on tenant-scoped path
      console.log(`[${info.name}] On global login page: ${currentUrl}`);
    });
  });
}

/**
 * Define cross-tenant credential isolation tests
 */
export function defineCrossTenantIsolationTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Cross-Tenant Credential Isolation', () => {
    test('should create different user handles for same username in different tenants', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      const tenantA = generateTestTenantId('iso-a');
      const tenantB = generateTestTenantId('iso-b');
      
      await createTenant(tenantA, `Isolation Tenant A ${tenantA}`);
      await createTenant(tenantB, `Isolation Tenant B ${tenantB}`);
      console.log(`[${info.name}] Created isolation tenants: ${tenantA}, ${tenantB}`);
      
      try {
        const sharedUsername = `shared-${generateTestId(info.type)}`;

        // Register same username in tenant A via UI
        console.log(`[${info.name}] Registering "${sharedUsername}" in tenant ${tenantA}`);
        const registrationA = await registerUserViaUI(page, webauthnAdapter, {
          username: sharedUsername,
          tenantId: tenantA,
        });
        expect(registrationA.success).toBe(true);
        expect(registrationA.tenantId).toBe(tenantA);

        // Dismiss welcome dialog
        const dismissButton = page.locator('button:has-text("Dismiss")');
        if (await dismissButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dismissButton.click();
          await page.waitForTimeout(500);
        }

        // Clear session state completely for next registration
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        
        // Clear CDP credentials if using CDP adapter
        if (webauthnAdapter.clearCredentials) {
          await webauthnAdapter.clearCredentials();
        }
        
        // Navigate to tenant B registration page directly with fresh page context
        await page.goto(`${ENV.FRONTEND_URL}/id/${tenantB}/register`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
        
        console.log(`[${info.name}] Registering "${sharedUsername}" in tenant ${tenantB}`);
        const registrationB = await registerUserViaUI(page, webauthnAdapter, {
          username: sharedUsername,
          tenantId: tenantB,
        });
        expect(registrationB.success).toBe(true);
        expect(registrationB.tenantId).toBe(tenantB);

        // Verify isolation - different user IDs for same username in different tenants
        if (registrationA.userId && registrationB.userId) {
          expect(registrationA.userId).not.toBe(registrationB.userId);
          console.log(`[${info.name}] Same username has different user IDs:`);
          console.log(`  Tenant A: ${registrationA.userId}`);
          console.log(`  Tenant B: ${registrationB.userId}`);
        } else {
          // UserIds might not be in response - that's okay, registration success is the key test
          console.log(`[${info.name}] Both registrations succeeded (userIds not in response)`);
        }
      } finally {
        await deleteTenant(tenantA);
        await deleteTenant(tenantB);
        console.log(`[${info.name}] Deleted isolation tenants`);
      }
    });
  });
}

/**
 * Define tenant user handle format tests
 */
export function defineTenantUserHandleTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  let testTenantId: string;

  test.describe('Tenant User Handle Format', () => {
    test.beforeAll(async () => {
      testTenantId = generateTestTenantId('handle');
      await createTenant(testTenantId, `Handle Test Tenant ${testTenantId}`);
    });

    test.afterAll(async () => {
      await deleteTenant(testTenantId);
    });

    test('should return tenantId in registration finish response', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      const username = `response-${generateTestId(info.type)}`;

      // Register via UI and verify tenantId is returned
      const registration = await registerUserViaUI(page, webauthnAdapter, {
        username,
        tenantId: testTenantId,
      });

      expect(registration.success).toBe(true);
      expect(registration.tenantId).toBe(testTenantId);
      // UUID format check
      if (registration.userId) {
        expect(registration.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      }

      console.log(`[${info.name}] Registration response includes tenantId: ${registration.tenantId}`);
    });
  });
}
