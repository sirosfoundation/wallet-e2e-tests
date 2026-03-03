/**
 * Shared Backend Capabilities Test Definitions
 * 
 * These tests verify backend health and capabilities.
 * They are API-only and don't require WebAuthn, so they work identically
 * in both CDP and soft-fido2 test environments.
 */

import { expect, request } from '@playwright/test';
import type { TestType, PlaywrightTestArgs, PlaywrightTestOptions } from '@playwright/test';
import type { WebAuthnAdapterInfo, WebAuthnFixtures } from '../../helpers/webauthn-adapter';
import {
  ENV,
  generateTestId,
  generateTestTenantId,
  createTenant,
  deleteTenant,
} from '../../helpers/shared-helpers';
import {
  fetchBackendStatus,
  isWebSocketAvailable,
  getTransportDescription,
  clearStatusCache,
} from '../../helpers/backend-capabilities';

// =============================================================================
// Test Definitions
// =============================================================================

/**
 * Define backend capabilities tests
 */
export function defineBackendCapabilitiesTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Backend Capabilities Check', () => {
    test('detect available transport modes', async ({ request: reqContext }) => {
      const info = adapterInfo();
      clearStatusCache();

      const status = await fetchBackendStatus(true);
      expect(status).not.toBeNull();
      expect(status?.status).toBe('ok');

      const wsAvailable = await isWebSocketAvailable();
      const transportDesc = await getTransportDescription();

      console.log(`[${info.name}] Backend Capabilities:`);
      console.log(`  Service: ${status?.service || 'unknown'}`);
      console.log(`  Version: ${status?.version || 'unknown'}`);
      console.log(`  API version: ${status?.api_version || 1}`);
      console.log(`  Transport: ${transportDesc}`);
      console.log(`  WebSocket available: ${wsAvailable}`);
      console.log(`  Capabilities: ${(status?.capabilities || []).join(', ') || 'none'}`);
    });

    test('backend health endpoint returns ok status', async ({ request: reqContext }) => {
      const response = await reqContext.get(`${ENV.BACKEND_URL}/status`);
      expect(response.ok()).toBe(true);
      
      const data = await response.json();
      expect(data.status).toBe('ok');
    });
  });
}

/**
 * Define tenant API tests (no WebAuthn required)
 */
export function defineTenantApiTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Tenant API Error Handling', () => {
    test('should return 404 for registration with non-existent tenant', async ({ request: reqContext }) => {
      const info = adapterInfo();
      
      // Test backend error handling for non-existent tenant
      const response = await reqContext.post(
        `${ENV.BACKEND_URL}/user/register-webauthn-begin`,
        {
          headers: { 'X-Tenant-ID': 'this-tenant-does-not-exist' },
          data: {},
        }
      );

      expect(response.status()).toBe(404);
      console.log(`[${info.name}] Non-existent tenant returns 404 as expected`);
    });

    test('should create and delete tenants via admin API', async ({ request: reqContext }) => {
      const info = adapterInfo();
      const testTenantId = generateTestTenantId('api-test');
      
      // Create tenant
      await createTenant(testTenantId, `API Test Tenant ${testTenantId}`);
      console.log(`[${info.name}] Created tenant: ${testTenantId}`);
      
      // Verify tenant exists (if admin API has GET endpoint)
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
      });
      
      // Delete tenant
      await deleteTenant(testTenantId);
      console.log(`[${info.name}] Deleted tenant: ${testTenantId}`);
      
      await adminApi.dispose();
    });
  });
}

/**
 * Define issuer/verifier health tests
 */
export function defineServiceHealthTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('External Service Health', () => {
    test('mock issuer is healthy', async ({ request: reqContext }) => {
      const info = adapterInfo();
      
      const response = await reqContext.get(`${ENV.ISSUER_URL}/health`);
      if (!response.ok()) {
        console.log(`[${info.name}] Mock issuer not available - skipping`);
        test.skip();
        return;
      }
      
      const data = await response.json();
      // Handle both mock format ({status: 'ok'}) and VC format ({data: {status: 'STATUS_OK_...'}})
      const isHealthy = data.status === 'ok' || (data.data?.status?.startsWith('STATUS_OK'));
      expect(isHealthy).toBe(true);
      console.log(`[${info.name}] Mock issuer is healthy`);
    });

    test('mock verifier is healthy', async ({ request: reqContext }) => {
      const info = adapterInfo();
      
      const response = await reqContext.get(`${ENV.VERIFIER_URL}/health`);
      if (!response.ok()) {
        console.log(`[${info.name}] Mock verifier not available - skipping`);
        test.skip();
        return;
      }
      
      const data = await response.json();
      const isHealthy = data.status === 'ok' || (data.data?.status?.startsWith('STATUS_OK'));
      expect(isHealthy).toBe(true);
      console.log(`[${info.name}] Mock verifier is healthy`);
    });
  });
}
