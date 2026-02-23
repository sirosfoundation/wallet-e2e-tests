/**
 * Trust Integration E2E Tests - Full Browser Mode
 *
 * @tags @real-webauthn @e2e @trust @go-trust
 *
 * These tests verify trust evaluation works correctly with different trust modes.
 * The tests use the mock PDP which can mimic go-trust static registries:
 * - 'always' mode: Like AlwaysTrustedRegistry - always trusts
 * - 'never' mode: Like NeverTrustedRegistry - always denies
 * - 'default' mode: Uses configured issuer/verifier lists
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
 * Prerequisites:
 *   SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   make test-trust
 */

import { test, expect, request } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ISSUER_URL = process.env.ISSUER_URL || 'http://localhost:9000';
const MOCK_PDP_URL = process.env.MOCK_PDP_URL || 'http://localhost:9091';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `trust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Set trust mode on the mock PDP.
 * Modes: 'default' | 'always' | 'never'
 */
async function setTrustMode(mode: 'default' | 'always' | 'never'): Promise<void> {
  const ctx = await request.newContext();
  const response = await ctx.post(`${MOCK_PDP_URL}/mode`, {
    data: { mode },
  });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.mode).toBe(mode);
  console.log(`Trust mode set to: ${mode}`);
}

/**
 * Get current trust mode from mock PDP.
 */
async function getTrustMode(): Promise<string> {
  const ctx = await request.newContext();
  const response = await ctx.get(`${MOCK_PDP_URL}/mode`);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  return result.mode;
}

/**
 * Check if mock PDP is available.
 */
async function isPDPAvailable(): Promise<boolean> {
  try {
    const ctx = await request.newContext();
    const response = await ctx.get(`${MOCK_PDP_URL}/health`, { timeout: 3000 });
    return response.ok();
  } catch {
    return false;
  }
}

/**
 * Create a tenant via admin API.
 */
async function createTenant(tenantId: string, name?: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
    data: { id: tenantId, name: name || `Trust Test Tenant ${tenantId}` },
  });
  expect(response.ok()).toBe(true);
}

/**
 * Delete a tenant via admin API.
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
 * Add an issuer to a tenant.
 */
async function addIssuerToTenant(tenantId: string, issuerUrl: string): Promise<void> {
  const adminApi = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await adminApi.post(`${ADMIN_URL}/admin/tenants/${tenantId}/issuers`, {
    data: { 
      credential_issuer_identifier: issuerUrl,
      visible: true,
    },
  });
  expect(response.ok()).toBe(true);
}

/**
 * Register a user via UI.
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

  let finishResponse: any = null;
  let apiError: string | undefined;

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
  const signupButton = page.locator('[id*="signUpPasskey"][id*="security-key"][id*="submit"]');
  await expect(signupButton).toBeVisible({ timeout: 10000 });

  try {
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('register-webauthn-finish'),
      { timeout: 30000 }
    );

    await signupButton.click();
    await page.waitForTimeout(3000);

    // Handle PRF retry dialog
    const continueButton = page.locator('button:has-text("Continue")');
    if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await continueButton.click();
    }

    await responsePromise;
  } catch (error) {
    if (apiError) {
      return { success: false, error: apiError };
    }
    return { success: false, error: String(error) };
  }

  await page.waitForTimeout(500);

  if (finishResponse) {
    return { success: true, userId: finishResponse.uuid };
  }

  return { success: false, error: apiError || 'No finish response' };
}

// =============================================================================
// Test Suites
// =============================================================================

test.describe('Trust Integration - PDP Mode Control @trust', () => {
  test.beforeAll(async () => {
    const available = await isPDPAvailable();
    if (!available) {
      test.skip(true, 'Mock PDP not available');
    }
  });

  test.afterAll(async () => {
    // Reset to default mode after tests
    try {
      await setTrustMode('default');
    } catch {
      // Ignore
    }
  });

  test('PDP health endpoint returns mode information', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${MOCK_PDP_URL}/health`);

    expect(response.ok()).toBe(true);
    const health = await response.json();
    expect(health.status).toBe('ok');
    expect(health.mode).toBeDefined();
    expect(['default', 'always', 'never']).toContain(health.mode);
  });

  test('can switch PDP to always-trusted mode', async () => {
    await setTrustMode('always');
    const mode = await getTrustMode();
    expect(mode).toBe('always');
  });

  test('can switch PDP to never-trusted mode', async () => {
    await setTrustMode('never');
    const mode = await getTrustMode();
    expect(mode).toBe('never');
  });

  test('can switch PDP back to default mode', async () => {
    await setTrustMode('default');
    const mode = await getTrustMode();
    expect(mode).toBe('default');
  });

  test('PDP in always mode returns decision=true for any entity', async () => {
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
  });

  test('PDP in never mode returns decision=false for any entity', async () => {
    await setTrustMode('never');

    const ctx = await request.newContext();
    const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: { type: 'user', id: 'test-user' },
        resource: { type: 'issuer', id: ISSUER_URL, properties: { role: 'issuer' } },
        action: { name: 'trust' },
      },
    });

    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.decision).toBe(false);
    expect(result.context.mode).toBe('never');
  });

  test('PDP in default mode trusts configured issuers', async () => {
    await setTrustMode('default');

    const ctx = await request.newContext();
    const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: { type: 'user', id: 'test-user' },
        resource: { type: 'issuer', id: ISSUER_URL, properties: { role: 'issuer' } },
        action: { name: 'trust' },
      },
    });

    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.decision).toBe(true);
    expect(result.context.mode).toBe('default');
  });
});

test.describe('Trust Integration - User Registration with Trust @trust @real-webauthn', () => {
  let testTenantId: string;

  test.beforeAll(async () => {
    const available = await isPDPAvailable();
    if (!available) {
      test.skip(true, 'Mock PDP not available');
    }

    // Create test tenant
    testTenantId = `trust-test-${generateTestId()}`;
    await createTenant(testTenantId, 'Trust Integration Test Tenant');
    await addIssuerToTenant(testTenantId, ISSUER_URL);

    // Ensure PDP is in default (trusted) mode
    await setTrustMode('default');
  });

  test.afterAll(async () => {
    // Cleanup
    await deleteTenant(testTenantId);
    try {
      await setTrustMode('default');
    } catch {
      // Ignore
    }
  });

  test('user can register when trust is enabled (default mode)', async ({ page }) => {
    // Ensure trust is in default mode (trusted issuers)
    await setTrustMode('default');

    const username = `trust-user-${generateTestId()}`;
    const result = await registerUserViaUI(page, { username, tenantId: testTenantId });

    // Registration should succeed
    expect(result.success).toBe(true);
    expect(result.userId).toBeDefined();
    console.log(`User registered with ID: ${result.userId}`);
  });

  test('user can register when trust is in always-trusted mode', async ({ page }) => {
    // Set to always-trusted mode
    await setTrustMode('always');

    const username = `always-user-${generateTestId()}`;
    const result = await registerUserViaUI(page, { username, tenantId: testTenantId });

    // Registration should succeed
    expect(result.success).toBe(true);
    expect(result.userId).toBeDefined();
    console.log(`User registered (always mode) with ID: ${result.userId}`);
  });
});

test.describe('Trust Integration - AuthZEN Discovery @trust', () => {
  test('PDP provides AuthZEN discovery endpoint', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${MOCK_PDP_URL}/.well-known/authzen-configuration`);

    expect(response.ok()).toBe(true);
    const config = await response.json();

    // Verify AuthZEN metadata structure
    expect(config.policy_decision_point).toBeDefined();
    expect(config.access_evaluation_endpoint).toBeDefined();
    expect(config.api_version).toBeDefined();
  });

  test('AuthZEN evaluation endpoint accepts valid requests', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: {
          type: 'wallet',
          id: 'test-wallet-123',
        },
        resource: {
          type: 'issuer',
          id: ISSUER_URL,
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

    // Should have decision and context
    expect(typeof result.decision).toBe('boolean');
    expect(result.context).toBeDefined();
  });
});

test.describe('Trust Integration - go-trust Static Registry Compatibility @trust', () => {
  /**
   * These tests verify the mock PDP behaves like go-trust's static registries.
   * When go-trust is used in E2E tests instead of mock PDP, these tests should
   * continue to pass with identical behavior.
   */

  test.beforeAll(async () => {
    const available = await isPDPAvailable();
    if (!available) {
      test.skip(true, 'Mock PDP not available');
    }
  });

  test.afterAll(async () => {
    try {
      await setTrustMode('default');
    } catch {
      // Ignore
    }
  });

  test('always mode mimics AlwaysTrustedRegistry behavior', async () => {
    await setTrustMode('always');

    const ctx = await request.newContext();
    
    // Test with various resource types
    const testCases = [
      { type: 'issuer', id: 'https://untrusted.example.com', role: 'issuer' },
      { type: 'verifier', id: 'https://unknown-verifier.example.com', role: 'verifier' },
      { type: 'entity', id: 'did:web:random.example.com', role: 'issuer' },
    ];

    for (const tc of testCases) {
      const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
        data: {
          subject: { type: 'wallet', id: 'test' },
          resource: { type: tc.type, id: tc.id, properties: { role: tc.role } },
          action: { name: 'trust' },
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();
      
      // AlwaysTrustedRegistry always returns true
      expect(result.decision).toBe(true);
      expect(result.context.mode).toBe('always');
      expect(result.context.trust_framework).toBe('static-always');
    }
  });

  test('never mode mimics NeverTrustedRegistry behavior', async () => {
    await setTrustMode('never');

    const ctx = await request.newContext();
    
    // Even the configured trusted issuer should be denied in never mode
    const response = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: { type: 'wallet', id: 'test' },
        resource: { type: 'issuer', id: ISSUER_URL, properties: { role: 'issuer' } },
        action: { name: 'trust' },
      },
    });

    expect(response.ok()).toBe(true);
    const result = await response.json();
    
    // NeverTrustedRegistry always returns false
    expect(result.decision).toBe(false);
    expect(result.context.mode).toBe('never');
    expect(result.context.trust_framework).toBe('static-never');
  });

  test('default mode applies configured trust policies', async () => {
    await setTrustMode('default');

    const ctx = await request.newContext();
    
    // Configured issuer should be trusted
    const trustedResponse = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: { type: 'wallet', id: 'test' },
        resource: { type: 'issuer', id: ISSUER_URL, properties: { role: 'issuer' } },
        action: { name: 'trust' },
      },
    });

    expect(trustedResponse.ok()).toBe(true);
    const trustedResult = await trustedResponse.json();
    expect(trustedResult.decision).toBe(true);
    expect(trustedResult.context.mode).toBe('default');

    // Unknown issuer should not be trusted (unless localhost)
    const untrustedResponse = await ctx.post(`${MOCK_PDP_URL}/access/v1/evaluation`, {
      data: {
        subject: { type: 'wallet', id: 'test' },
        resource: { type: 'issuer', id: 'https://evil-issuer.example.com', properties: { role: 'issuer' } },
        action: { name: 'trust' },
      },
    });

    expect(untrustedResponse.ok()).toBe(true);
    const untrustedResult = await untrustedResponse.json();
    expect(untrustedResult.decision).toBe(false);
    expect(untrustedResult.context.mode).toBe('default');
  });
});
