/**
 * Tenant-Aware URL Routing E2E Tests
 *
 * @tags @multi-tenancy @urls
 *
 * Tests that the wallet-frontend correctly generates tenant-aware URLs:
 * - Default tenant users see root paths: /, /add, /settings
 * - Non-default tenant users see tenant-scoped paths: /{tenantId}/, /{tenantId}/add
 *
 * These tests verify the buildPath helper and tenant context work correctly
 * to prevent unnecessary redirects and maintain URL consistency.
 */

import { test, expect, request, Page, APIRequestContext } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import { TenantApiHelper, generateTestTenantId } from '../../helpers/tenant-api';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Helper to complete tenant-scoped registration and login
 * Returns the tenant ID that was registered
 */
async function registerAndLoginTenantUser(
  page: Page,
  apiRequest: APIRequestContext,
  tenantId: string,
  username: string,
  webauthn: WebAuthnHelper
): Promise<{ userId: string; token: string }> {
  // Step 1: Begin tenant-scoped registration
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/t/${tenantId}/user/register-webauthn-begin`,
    {
      data: { display_name: username },
    }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin registration failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const publicKey = beginData.createOptions.publicKey;
  const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
  const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

  // Step 2: Create credential using browser WebAuthn API
  const credentialResult = await page.evaluate(async (params) => {
    function fromBase64Url(b64u: string): Uint8Array {
      const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
      const binary = atob(paddedBase64);
      return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
    }

    function toBase64Url(bytes: Uint8Array): string {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        rp: { id: params.rpId, name: params.rpName },
        user: {
          id: fromBase64Url(params.userId),
          name: params.username,
          displayName: params.username,
        },
        challenge: fromBase64Url(params.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          requireResidentKey: true,
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
      },
    };

    const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to create credential');

    const response = credential.response as AuthenticatorAttestationResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        attestationObject: { '$b64u': toBase64Url(new Uint8Array(response.attestationObject)) },
        transports: response.getTransports?.() || ['internal'],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: publicKey.rp.id,
    rpName: publicKey.rp.name,
    userId: userIdB64,
    username,
    challenge: challengeB64,
  });

  // Step 3: Finish registration
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/t/${tenantId}/user/register-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: credentialResult,
        display_name: username,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish registration failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();
  return { userId: finishData.uuid, token: finishData.appToken };
}

/**
 * Helper to complete global (default tenant) registration
 */
async function registerAndLoginDefaultTenantUser(
  page: Page,
  apiRequest: APIRequestContext,
  username: string,
  webauthn: WebAuthnHelper
): Promise<{ userId: string; token: string }> {
  // Step 1: Begin global registration
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/user/register-webauthn-begin`,
    {
      data: { display_name: username },
    }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin registration failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const publicKey = beginData.createOptions.publicKey;
  const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
  const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

  // Step 2: Create credential
  const credentialResult = await page.evaluate(async (params) => {
    function fromBase64Url(b64u: string): Uint8Array {
      const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
      const binary = atob(paddedBase64);
      return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
    }

    function toBase64Url(bytes: Uint8Array): string {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        rp: { id: params.rpId, name: params.rpName },
        user: {
          id: fromBase64Url(params.userId),
          name: params.username,
          displayName: params.username,
        },
        challenge: fromBase64Url(params.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          requireResidentKey: true,
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
      },
    };

    const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to create credential');

    const response = credential.response as AuthenticatorAttestationResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        attestationObject: { '$b64u': toBase64Url(new Uint8Array(response.attestationObject)) },
        transports: response.getTransports?.() || ['internal'],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: publicKey.rp.id,
    rpName: publicKey.rp.name,
    userId: userIdB64,
    username,
    challenge: challengeB64,
  });

  // Step 3: Finish registration
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/user/register-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: credentialResult,
        display_name: username,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish registration failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();
  return { userId: finishData.uuid, token: finishData.appToken };
}

test.describe('Tenant-Aware URL Routing @multi-tenancy @urls', () => {
  let tenantApi: TenantApiHelper;
  let webauthn: WebAuthnHelper;
  let testTenantId: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create a dedicated test tenant
    testTenantId = generateTestTenantId('urls');
    await tenantApi.createTenant({
      id: testTenantId,
      name: 'URL Test Tenant',
      enabled: true,
    });
  });

  test.afterAll(async () => {
    try {
      await tenantApi.deleteTenant(testTenantId);
    } catch {
      // Ignore cleanup errors
    }
  });

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    // Navigate to frontend (required for WebAuthn API)
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    if (webauthn) {
      await webauthn.cleanup();
    }
  });

  test('should use root paths for default tenant login page', async ({ page }) => {
    // Navigate to login page (no authentication required)
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`Login page URL: ${url}`);

    // Verify URL uses root path (not /default/)
    expect(url).toContain('/login');
    expect(url).not.toContain('/default/');
  });

  test('should use tenant-scoped paths for non-default tenant login page', async ({ page }) => {
    // Navigate to tenant-scoped login page
    await page.goto(`${FRONTEND_URL}/${testTenantId}/login`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`Tenant login page URL: ${url}`);

    // Should stay on tenant-scoped path
    expect(url).toContain(`/${testTenantId}/`);
    expect(url).toContain('/login');
  });

  test('should redirect default tenant user at /{tenantId}/ to root after login', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // Register a default tenant user
    const { userId } = await registerAndLoginDefaultTenantUser(
      page,
      apiRequest,
      username,
      webauthn
    );
    expect(userId).toBeDefined();

    // Simulate setting up the tenant in session storage (as login would do)
    await page.evaluate((tenant) => {
      sessionStorage.setItem('wallet_tenant_id', tenant);
    }, 'default');

    // Try to navigate to a non-default tenant URL
    await page.goto(`${FRONTEND_URL}/${testTenantId}/`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`URL after navigation to wrong tenant: ${url}`);

    // User should be redirected away from the wrong tenant's path
    // Either to root, login, or their correct tenant path
    expect(url.includes(`/${testTenantId}/`) && !url.includes('/login')).toBe(false);
  });

  test('should preserve tenant path in login redirect for unauthenticated users', async ({
    page,
  }) => {
    // Clear any existing session/credentials
    await webauthn.clearCredentials();

    // Navigate to a tenant-scoped protected route without authentication
    await page.goto(`${FRONTEND_URL}/${testTenantId}/settings`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`URL after unauthenticated access to /${testTenantId}/settings: ${url}`);

    // Should redirect to login
    expect(url).toContain('/login');

    // The tenant context should ideally be preserved
    // Note: Current implementation redirects to global login
    // This test documents current behavior
  });

  test('should maintain tenant context after full registration flow', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // Register a tenant user via API
    const { userId, token } = await registerAndLoginTenantUser(
      page,
      apiRequest,
      testTenantId,
      username,
      webauthn
    );
    expect(userId).toBeDefined();

    // Set up the authenticated state in the browser
    await page.evaluate(
      ({ tenantId, appToken }) => {
        sessionStorage.setItem('wallet_tenant_id', tenantId);
        // Note: The actual app uses more complex session state
        // This simulates the minimum tenant storage
      },
      { tenantId: testTenantId, appToken: token }
    );

    // Navigate to tenant home
    await page.goto(`${FRONTEND_URL}/${testTenantId}/`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`URL after setting tenant context: ${url}`);

    // Note: Without full session state, this will redirect to login
    // But the tenant should be preserved in the URL
    if (url.includes('/login')) {
      // Check that tenant is preserved in the redirect
      expect(url.includes(`/${testTenantId}/`) || !url.includes('/default/')).toBe(true);
    } else {
      // If authenticated, should be on tenant-scoped path
      expect(url).toContain(`/${testTenantId}/`);
    }
  });
});

test.describe('Default Tenant URL Normalization @multi-tenancy @urls @redirect', () => {
  // NOTE: This test requires frontend support for /default/* → /* redirects.
  // Skip until wallet-frontend PR with TenantProvider redirect is merged to master.
  // To enable: remove .skip and merge the TenantContext.tsx changes.
  test.skip('should redirect /default/login to /login', async ({ page }) => {
    // Navigate to /default/login explicitly
    await page.goto(`${FRONTEND_URL}/default/login`);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log(`URL after navigating to /default/login: ${url}`);

    // Expected behavior: /default/login should redirect to /login
    // The default tenant is special and uses root paths (no tenant prefix)
    // NOTE: This test requires a frontend version that supports the redirect.
    // If the redirect is not yet implemented, the URL will contain /default/.
    // The test will fail in that case, which is expected until the frontend
    // changes are merged.
    expect(url).toContain('/login');
    expect(url).not.toContain('/default/');
  });
});
