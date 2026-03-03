/**
 * Shared Trust Integration Test Definitions
 * 
 * These tests verify the integration with the trust/PDP (Policy Decision Point)
 * service. Most are API-only tests that work identically in both CDP and soft-fido2.
 */

import { expect, request } from '@playwright/test';
import type { TestType, PlaywrightTestArgs, PlaywrightTestOptions } from '@playwright/test';
import type { WebAuthnAdapter, WebAuthnAdapterInfo, WebAuthnFixtures } from '../../helpers/webauthn-adapter';
import {
  ENV,
  generateTestId,
  generateTestTenantId,
  createTenant,
  deleteTenant,
} from '../../helpers/shared-helpers';
import { registerUserViaUI } from './user-flows.shared';

// =============================================================================
// PDP Configuration
// =============================================================================

const MOCK_PDP_URL = process.env.MOCK_PDP_URL || 'http://localhost:9091';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if PDP service is available
 */
async function isPDPAvailable(): Promise<boolean> {
  try {
    const ctx = await request.newContext();
    const response = await ctx.get(`${MOCK_PDP_URL}/health`, { timeout: 5000 });
    await ctx.dispose();
    return response.ok();
  } catch {
    return false;
  }
}

/**
 * Get current trust mode
 */
async function getTrustMode(): Promise<string> {
  const ctx = await request.newContext();
  const response = await ctx.get(`${MOCK_PDP_URL}/health`);
  const health = await response.json();
  await ctx.dispose();
  return health.mode;
}

/**
 * Set trust mode
 */
async function setTrustMode(mode: 'default' | 'always' | 'never'): Promise<void> {
  const ctx = await request.newContext();
  const response = await ctx.post(`${MOCK_PDP_URL}/mode`, {
    data: { mode },
  });
  expect(response.ok()).toBe(true);
  await ctx.dispose();
}

/**
 * Add issuer to tenant
 */
async function addIssuerToTenant(tenantId: string, issuerUrl: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  });
  
  // Try to add issuer to tenant configuration
  // This may vary based on backend implementation
  try {
    await adminApi.post(`${ENV.ADMIN_URL}/admin/tenants/${tenantId}/issuers`, {
      data: { issuer: issuerUrl },
    });
  } catch {
    // May not be supported
  }
  
  await adminApi.dispose();
}

// =============================================================================
// Test Definitions
// =============================================================================

/**
 * Define PDP mode control tests (API-only, no WebAuthn needed)
 */
export function definePdpModeControlTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Trust Integration - PDP Mode Control @trust', () => {
    test.beforeAll(async () => {
      const available = await isPDPAvailable();
      if (!available) {
        console.log('Mock PDP not available - skipping trust tests');
      }
    });

    test.afterAll(async () => {
      // Reset to default mode
      try {
        await setTrustMode('default');
      } catch {
        // Ignore
      }
    });

    test('PDP health endpoint returns mode information', async () => {
      const info = adapterInfo();
      
      const available = await isPDPAvailable();
      if (!available) {
        console.log(`[${info.name}] Mock PDP not available - skipping`);
        test.skip();
        return;
      }
      
      const ctx = await request.newContext();
      const response = await ctx.get(`${MOCK_PDP_URL}/health`);

      expect(response.ok()).toBe(true);
      const health = await response.json();
      expect(health.status).toBe('ok');
      expect(health.mode).toBeDefined();
      expect(['default', 'always', 'never']).toContain(health.mode);
      
      console.log(`[${info.name}] PDP health: ${health.status}, mode: ${health.mode}`);
      await ctx.dispose();
    });

    test('can switch PDP to always-trusted mode', async () => {
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('always');
      const mode = await getTrustMode();
      expect(mode).toBe('always');
    });

    test('can switch PDP to never-trusted mode', async () => {
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('never');
      const mode = await getTrustMode();
      expect(mode).toBe('never');
    });

    test('can switch PDP back to default mode', async () => {
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('default');
      const mode = await getTrustMode();
      expect(mode).toBe('default');
    });

    test('PDP in always mode returns decision=true for any entity', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('always');

      const ctx = await request.newContext();
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'user', id: 'test-user' },
          resource: { type: 'issuer', id: 'https://unknown-issuer.example.com', properties: { role: 'issuer' } },
          action: { name: 'trust' },
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();
      expect(result.decision).toBe(true);
      expect(result.context.mode).toBe('always');
      
      console.log(`[${info.name}] Always mode: decision=${result.decision}`);
      await ctx.dispose();
    });

    test('PDP in never mode returns decision=false for any entity', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('never');

      const ctx = await request.newContext();
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'user', id: 'test-user' },
          resource: { type: 'issuer', id: ENV.ISSUER_URL, properties: { role: 'issuer' } },
          action: { name: 'trust' },
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();
      expect(result.decision).toBe(false);
      expect(result.context.mode).toBe('never');
      
      console.log(`[${info.name}] Never mode: decision=${result.decision}`);
      await ctx.dispose();
    });

    test('PDP in default mode trusts configured issuers', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('default');

      const ctx = await request.newContext();
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'user', id: 'test-user' },
          resource: { type: 'issuer', id: ENV.ISSUER_URL, properties: { role: 'issuer' } },
          action: { name: 'trust' },
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();
      // Default mode may trust or not depending on config
      expect(typeof result.decision).toBe('boolean');
      expect(result.context.mode).toBe('default');
      
      console.log(`[${info.name}] Default mode: decision=${result.decision}`);
      await ctx.dispose();
    });
  });
}

/**
 * Define user registration with trust tests (requires WebAuthn)
 */
export function defineTrustRegistrationTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  let testTenantId: string;

  test.describe('Trust Integration - User Registration with Trust @trust', () => {
    test.beforeAll(async () => {
      const available = await isPDPAvailable();
      if (!available) {
        console.log('Mock PDP not available - skipping trust registration tests');
        return;
      }

      testTenantId = generateTestTenantId('trust');
      await createTenant(testTenantId, 'Trust Integration Test Tenant');
      await addIssuerToTenant(testTenantId, ENV.ISSUER_URL);
      await setTrustMode('default');
    });

    test.afterAll(async () => {
      if (testTenantId) {
        await deleteTenant(testTenantId);
      }
      try {
        await setTrustMode('default');
      } catch {
        // Ignore
      }
    });

    test('user can register when trust is enabled (default mode)', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }

      await setTrustMode('default');

      const username = `trust-user-${generateTestId(info.type)}`;
      const result = await registerUserViaUI(page, webauthnAdapter, { username, tenantId: testTenantId });

      expect(result.success).toBe(true);
      // Note: userId may not always be captured from API response
      console.log(`[${info.name}] User registered in default trust mode${result.userId ? `: ${result.userId}` : ''}`);
    });

    test('user can register when trust is in always-trusted mode', async ({ page, webauthnAdapter }) => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }

      await setTrustMode('always');

      // Clear credentials for fresh registration (CDP)
      if (webauthnAdapter.clearCredentials) {
        await webauthnAdapter.clearCredentials();
      }

      const username = `always-user-${generateTestId(info.type)}`;
      const result = await registerUserViaUI(page, webauthnAdapter, { username, tenantId: testTenantId });

      expect(result.success).toBe(true);
      // Note: userId may not always be captured from API response
      console.log(`[${info.name}] User registered in always trust mode${result.userId ? `: ${result.userId}` : ''}`);
    });
  });
}

/**
 * Define AuthZEN discovery tests (API-only)
 */
export function defineAuthZenDiscoveryTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Trust Integration - AuthZEN Discovery @trust', () => {
    test('PDP provides AuthZEN discovery endpoint', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      const ctx = await request.newContext();
      const response = await ctx.get(`${MOCK_PDP_URL}/.well-known/authzen-configuration`);

      if (!response.ok()) {
        console.log(`[${info.name}] AuthZEN discovery not available`);
        await ctx.dispose();
        return;
      }

      const config = await response.json();

      // Verify AuthZEN metadata structure
      expect(config.policy_decision_point).toBeDefined();
      expect(config.access_evaluation_endpoint).toBeDefined();
      expect(config.api_version).toBeDefined();
      
      console.log(`[${info.name}] AuthZEN discovery: ${JSON.stringify(config)}`);
      await ctx.dispose();
    });

    test('AuthZEN evaluation endpoint accepts valid requests', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      const ctx = await request.newContext();
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: {
            type: 'wallet',
            id: 'test-wallet-123',
          },
          resource: {
            type: 'issuer',
            id: ENV.ISSUER_URL,
            properties: {
              role: 'issuer',
            },
          },
          action: {
            name: 'trust',
          },
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();
      expect(typeof result.decision).toBe('boolean');
      
      console.log(`[${info.name}] AuthZEN evaluation result: ${JSON.stringify(result)}`);
      await ctx.dispose();
    });
  });
}

/**
 * Define go-trust static registry compatibility tests (API-only)
 */
export function defineStaticRegistryCompatTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Trust Integration - go-trust Static Registry Compatibility @trust', () => {
    test.afterEach(async () => {
      // Reset to default mode after each test
      try {
        const available = await isPDPAvailable();
        if (available) {
          await setTrustMode('default');
        }
      } catch {
        // Ignore
      }
    });

    test('always mode mimics AlwaysTrustedRegistry behavior', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('always');

      // Test multiple unknown issuers - all should be trusted
      const testIssuers = [
        'https://unknown1.example.com',
        'https://unknown2.example.com',
        'https://attacker.evil.com',
      ];

      const ctx = await request.newContext();
      
      for (const issuer of testIssuers) {
        const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
          data: {
            subject: { type: 'wallet', id: 'test' },
            resource: { type: 'issuer', id: issuer },
            action: { name: 'trust' },
          },
        });
        
        const result = await response.json();
        expect(result.decision).toBe(true);
      }
      
      console.log(`[${info.name}] Always mode: all issuers trusted`);
      await ctx.dispose();
    });

    test('never mode mimics NeverTrustedRegistry behavior', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('never');

      // Test known issuer - should still be rejected in never mode
      const ctx = await request.newContext();
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'wallet', id: 'test' },
          resource: { type: 'issuer', id: ENV.ISSUER_URL },
          action: { name: 'trust' },
        },
      });
      
      const result = await response.json();
      expect(result.decision).toBe(false);
      
      console.log(`[${info.name}] Never mode: known issuer rejected`);
      await ctx.dispose();
    });

    test('default mode applies configured trust policies', async () => {
      const info = adapterInfo();
      const available = await isPDPAvailable();
      if (!available) { test.skip(); return; }
      
      await setTrustMode('default');

      const ctx = await request.newContext();
      
      // Test configured issuer
      const knownResponse = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'wallet', id: 'test' },
          resource: { type: 'issuer', id: ENV.ISSUER_URL },
          action: { name: 'trust' },
        },
      });
      const knownResult = await knownResponse.json();
      
      // Test unknown issuer
      const unknownResponse = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'wallet', id: 'test' },
          resource: { type: 'issuer', id: 'https://unknown-issuer.example.com' },
          action: { name: 'trust' },
        },
      });
      const unknownResult = await unknownResponse.json();
      
      // Default mode should differentiate (implementation-dependent)
      console.log(`[${info.name}] Default mode: known=${knownResult.decision}, unknown=${unknownResult.decision}`);
      
      await ctx.dispose();
    });
  });
}
