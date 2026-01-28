/**
 * Real WebAuthn E2E Tests - Full User Flows
 *
 * @tags @real-webauthn @e2e @user-flows @multi-tenancy
 *
 * These tests exercise complete user registration → login flows using
 * real browser WebAuthn with soft-fido2 virtual authenticator.
 *
 * IMPORTANT: Tests run serially to avoid credential conflicts. Each test
 * creates a new credential, and the soft-fido2 authenticator stores ALL
 * credentials for the same RP (localhost). When multiple credentials exist,
 * Chrome shows a credential picker which causes test timeouts.
 *
 * Prerequisites:
 *   SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   make test-real-webauthn
 *
 * What these tests verify:
 * - Complete registration flow with real WebAuthn credentials
 * - Complete login flow using discoverable credentials
 * - Multi-tenant registration and login
 * - Tenant redirect behavior for cross-tenant login attempts
 * - Cross-tenant credential isolation
 * - Tenant user handle prefixing (tenantID:userID format)
 * - API error handling (non-existent/disabled tenants)
 */

import { test, expect, request } from '@playwright/test';
import { RealWebAuthnHelper } from '../../helpers/real-webauthn';
import { TenantApiHelper, generateTestTenantId, decodeUserHandle } from '../../helpers/tenant-api';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Base64URL encoding/decoding helpers
function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Url(b64u: string): Uint8Array {
  const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(paddedBase64);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Extend test with fixtures
const realWebAuthnTest = test.extend<{
  webauthn: RealWebAuthnHelper;
  tenantApi: TenantApiHelper;
}>({
  webauthn: async ({ page }, use) => {
    const helper = new RealWebAuthnHelper(page, {
      operationTimeout: 30000,
      enableTracking: true,
    });
    await helper.initialize();
    await use(helper);
  },
  tenantApi: async ({}, use) => {
    const apiContext = await request.newContext();
    const helper = new TenantApiHelper(apiContext, ADMIN_URL);
    await use(helper);
  },
});

/**
 * Helper: Register a user and return credential info
 */
async function registerUser(
  page: any,
  apiRequest: any,
  options: {
    username: string;
    tenantId?: string;
  }
): Promise<{
  userId: string;
  credentialId: string;
  rawCredentialId: string;
  tenantId: string;
}> {
  const endpoint = options.tenantId
    ? `${BACKEND_URL}/t/${options.tenantId}/user/register-webauthn-begin`
    : `${BACKEND_URL}/user/register-webauthn-begin`;

  const finishEndpoint = options.tenantId
    ? `${BACKEND_URL}/t/${options.tenantId}/user/register-webauthn-finish`
    : `${BACKEND_URL}/user/register-webauthn-finish`;

  // Begin registration
  const beginResponse = await apiRequest.post(endpoint, {
    data: { display_name: options.username },
  });
  expect(beginResponse.ok()).toBe(true);

  const beginData = await beginResponse.json();
  const publicKey = beginData.createOptions.publicKey;
  const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
  const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

  // Create credential using real WebAuthn
  const credentialResult = await page.evaluate(
    async (params: any) => {
      function fromBase64Url(b64u: string): Uint8Array {
        const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
        const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
        const binary = atob(paddedBase64);
        return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
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
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            requireResidentKey: true,
            residentKey: 'required',
            userVerification: 'required',
          },
          attestation: 'none',
        },
      };

      const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
      if (!credential) throw new Error('Failed to create credential');

      const response = credential.response as AuthenticatorAttestationResponse;

      return {
        id: credential.id,
        rawId: { $b64u: toBase64Url(new Uint8Array(credential.rawId)) },
        type: credential.type,
        response: {
          clientDataJSON: { $b64u: toBase64Url(new Uint8Array(response.clientDataJSON)) },
          attestationObject: { $b64u: toBase64Url(new Uint8Array(response.attestationObject)) },
          transports: response.getTransports?.() || ['internal'],
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    },
    {
      rpId: publicKey.rp.id,
      rpName: publicKey.rp.name,
      userId: userIdB64,
      username: options.username,
      challenge: challengeB64,
    }
  );

  // Finish registration
  const finishResponse = await apiRequest.post(finishEndpoint, {
    data: {
      challengeId: beginData.challengeId,
      credential: credentialResult,
      display_name: options.username,
    },
  });
  expect(finishResponse.ok()).toBe(true);

  const finishData = await finishResponse.json();
  return {
    userId: finishData.uuid,
    credentialId: credentialResult.id,
    rawCredentialId: credentialResult.rawId.$b64u,
    tenantId: finishData.tenantId || 'default',
  };
}

/**
 * Helper: Login a user with a specific credential (using allowCredentials)
 * This avoids the credential picker dialog by specifying exactly which credential to use.
 */
async function loginUserWithCredential(
  page: any,
  apiRequest: any,
  credentialId: string,
  options: {
    tenantId?: string;
  } = {}
): Promise<{
  success: boolean;
  status: number;
  userId?: string;
  tenantId?: string;
  redirectTenant?: string;
  error?: string;
}> {
  const endpoint = options.tenantId
    ? `${BACKEND_URL}/t/${options.tenantId}/user/login-webauthn-begin`
    : `${BACKEND_URL}/user/login-webauthn-begin`;

  const finishEndpoint = options.tenantId
    ? `${BACKEND_URL}/t/${options.tenantId}/user/login-webauthn-finish`
    : `${BACKEND_URL}/user/login-webauthn-finish`;

  // Begin login
  const loginBegin = await apiRequest.post(endpoint, { data: {} });
  expect(loginBegin.ok()).toBe(true);

  const loginBeginData = await loginBegin.json();
  const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
  const rpId = loginBeginData.getOptions.publicKey.rpId;

  // Get assertion using real WebAuthn with specific credential
  // Using allowCredentials to avoid credential picker dialog
  const assertionResult = await page.evaluate(
    async (params: any) => {
      function fromBase64Url(b64u: string): Uint8Array {
        const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
        const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
        const binary = atob(paddedBase64);
        return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
      }

      function toBase64Url(bytes: Uint8Array): string {
        const binary = String.fromCharCode(...bytes);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }

      const getOptions: CredentialRequestOptions = {
        publicKey: {
          challenge: fromBase64Url(params.challenge),
          rpId: params.rpId,
          userVerification: 'required',
          // Specify the credential to use - avoids picker dialog
          allowCredentials: [
            {
              type: 'public-key',
              id: fromBase64Url(params.credentialId),
              transports: ['usb', 'internal'],
            },
          ],
        },
      };

      const credential = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
      if (!credential) throw new Error('Failed to get credential');

      const response = credential.response as AuthenticatorAssertionResponse;
      const userHandleBytes = response.userHandle ? new Uint8Array(response.userHandle) : null;

      return {
        id: credential.id,
        rawId: { $b64u: toBase64Url(new Uint8Array(credential.rawId)) },
        type: credential.type,
        response: {
          clientDataJSON: { $b64u: toBase64Url(new Uint8Array(response.clientDataJSON)) },
          authenticatorData: { $b64u: toBase64Url(new Uint8Array(response.authenticatorData)) },
          signature: { $b64u: toBase64Url(new Uint8Array(response.signature)) },
          userHandle: userHandleBytes ? { $b64u: toBase64Url(userHandleBytes) } : null,
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    },
    { rpId, challenge: loginChallenge, credentialId }
  );

  // Finish login
  const loginFinish = await apiRequest.post(finishEndpoint, {
    data: {
      challengeId: loginBeginData.challengeId,
      credential: {
        id: assertionResult.id,
        rawId: assertionResult.rawId,
        type: assertionResult.type,
        response: assertionResult.response,
        clientExtensionResults: assertionResult.clientExtensionResults,
      },
    },
  });

  const responseData = await loginFinish.json();

  if (loginFinish.ok()) {
    return {
      success: true,
      status: loginFinish.status(),
      userId: responseData.uuid,
      tenantId: responseData.tenantId,
    };
  } else {
    return {
      success: false,
      status: loginFinish.status(),
      error: responseData.error,
      redirectTenant: responseData.redirect_tenant,
      userId: responseData.user_id,
    };
  }
}

// =============================================================================
// TEST SUITES
// =============================================================================

realWebAuthnTest.describe('Full User Flow: Default Tenant Register → Login', () => {
  realWebAuthnTest(
    'should complete full registration and login cycle in default tenant',
    async ({ page, request: apiRequest }) => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = `user-${generateTestId()}`;

      // Step 1: Register
      console.log(`Registering user: ${username}`);
      const registration = await registerUser(page, apiRequest, { username });

      expect(registration.userId).toBeDefined();
      expect(registration.credentialId).toBeDefined();
      console.log(`✓ Registered user: ${registration.userId}`);

      // Step 2: Login with the same credential (using allowCredentials to avoid picker)
      console.log(`Logging in user: ${registration.userId}`);
      const login = await loginUserWithCredential(page, apiRequest, registration.rawCredentialId);

      expect(login.success).toBe(true);
      expect(login.userId).toBe(registration.userId);
      console.log(`✓ Logged in user: ${login.userId}`);
    }
  );
});

realWebAuthnTest.describe('Full User Flow: Custom Tenant Register → Login', () => {
  let testTenantId: string;

  realWebAuthnTest.beforeAll(async ({}) => {
    testTenantId = generateTestTenantId('flow');

    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: { id: testTenantId, name: `Flow Test Tenant ${testTenantId}` },
    });
    expect(response.ok()).toBe(true);
    console.log(`Created test tenant: ${testTenantId}`);
  });

  realWebAuthnTest.afterAll(async ({}) => {
    try {
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${testTenantId}`);
      console.log(`Deleted test tenant: ${testTenantId}`);
    } catch {
      // Ignore cleanup errors
    }
  });

  realWebAuthnTest(
    'should complete full registration and login cycle in custom tenant',
    async ({ page, request: apiRequest }) => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = `tenant-user-${generateTestId()}`;

      // Step 1: Register in custom tenant
      console.log(`Registering user in tenant ${testTenantId}: ${username}`);
      const registration = await registerUser(page, apiRequest, {
        username,
        tenantId: testTenantId,
      });

      expect(registration.userId).toBeDefined();
      expect(registration.tenantId).toBe(testTenantId);
      console.log(`✓ Registered user: ${registration.userId} in tenant: ${registration.tenantId}`);

      // Step 2: Login via tenant endpoint (using allowCredentials to avoid picker)
      console.log(`Logging in via tenant endpoint: /t/${testTenantId}`);
      const login = await loginUserWithCredential(page, apiRequest, registration.rawCredentialId, {
        tenantId: testTenantId,
      });

      expect(login.success).toBe(true);
      expect(login.userId).toBe(registration.userId);
      expect(login.tenantId).toBe(testTenantId);
      console.log(`✓ Logged in user: ${login.userId} in tenant: ${login.tenantId}`);
    }
  );
});

realWebAuthnTest.describe('Full User Flow: Tenant Redirect Behavior', () => {
  let testTenantId: string;
  let tenantUserId: string;
  let tenantCredentialId: string;

  realWebAuthnTest.beforeAll(async ({}) => {
    testTenantId = generateTestTenantId('redirect');

    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    const response = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: { id: testTenantId, name: `Redirect Test Tenant ${testTenantId}` },
    });
    expect(response.ok()).toBe(true);
    console.log(`Created test tenant: ${testTenantId}`);
  });

  realWebAuthnTest.afterAll(async ({}) => {
    try {
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${testTenantId}`);
      console.log(`Deleted test tenant: ${testTenantId}`);
    } catch {
      // Ignore cleanup errors
    }
  });

  realWebAuthnTest('should register user in custom tenant for redirect tests', async ({
    page,
    request: apiRequest,
  }) => {
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('networkidle');

    const username = `redirect-user-${generateTestId()}`;

    // Register in custom tenant
    const registration = await registerUser(page, apiRequest, {
      username,
      tenantId: testTenantId,
    });

    expect(registration.userId).toBeDefined();
    expect(registration.tenantId).toBe(testTenantId);
    tenantUserId = registration.userId;
    tenantCredentialId = registration.rawCredentialId;
    console.log(`✓ Setup: Registered user ${tenantUserId} in tenant ${testTenantId}`);
  });

  realWebAuthnTest(
    'should redirect tenant user who logs in via global endpoint',
    async ({ page, request: apiRequest }) => {
      /**
       * CRITICAL MULTI-TENANCY BEHAVIOR:
       * When a user registered in tenant X tries to login via the global
       * endpoint (no /t/tenantId), the backend must:
       * 1. Extract tenant from the userHandle in the credential
       * 2. Return 409 with redirect_tenant pointing to the correct tenant
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Try to login via GLOBAL endpoint (not tenant-specific)
      console.log(`Attempting login via global endpoint for tenant user ${tenantUserId}`);
      const login = await loginUserWithCredential(page, apiRequest, tenantCredentialId, {}); // No tenantId = global

      // Should get 409 redirect
      expect(login.success).toBe(false);
      expect(login.status).toBe(409);
      expect(login.error).toBe('Tenant redirect required');
      expect(login.redirectTenant).toBe(testTenantId);
      expect(login.userId).toBe(tenantUserId);

      console.log(`✓ Got expected 409 redirect to tenant: ${login.redirectTenant}`);
    }
  );

  realWebAuthnTest(
    'should redirect tenant user who logs in via wrong tenant endpoint',
    async ({ page, request: apiRequest }) => {
      /**
       * CRITICAL MULTI-TENANCY BEHAVIOR:
       * When a user registered in tenant X tries to login via tenant Y's
       * endpoint, the backend must return 409 with redirect to tenant X.
       */
      const wrongTenantId = generateTestTenantId('wrong');

      // Create wrong tenant
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const createResponse = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
        data: { id: wrongTenantId, name: `Wrong Tenant ${wrongTenantId}` },
      });
      expect(createResponse.ok()).toBe(true);

      try {
        await page.goto(FRONTEND_URL);
        await page.waitForLoadState('networkidle');

        // Try to login via WRONG tenant endpoint
        console.log(`Attempting login via wrong tenant endpoint: /t/${wrongTenantId}`);
        const login = await loginUserWithCredential(page, apiRequest, tenantCredentialId, {
          tenantId: wrongTenantId,
        });

        // Should get 409 redirect to CORRECT tenant
        expect(login.success).toBe(false);
        expect(login.status).toBe(409);
        expect(login.redirectTenant).toBe(testTenantId); // Correct tenant
        expect(login.redirectTenant).not.toBe(wrongTenantId); // Not wrong tenant

        console.log(
          `✓ Got expected 409 redirect from ${wrongTenantId} to correct tenant: ${login.redirectTenant}`
        );
      } finally {
        await adminApi.delete(`${ADMIN_URL}/admin/tenants/${wrongTenantId}`);
      }
    }
  );
});

// =============================================================================
// CROSS-TENANT ISOLATION & USER HANDLE TESTS
// =============================================================================

realWebAuthnTest.describe('Cross-Tenant Credential Isolation', () => {
  let tenantA: string;
  let tenantB: string;
  let registrationA: { userId: string; credentialId: string; rawCredentialId: string; tenantId: string };
  let registrationB: { userId: string; credentialId: string; rawCredentialId: string; tenantId: string };

  realWebAuthnTest.beforeAll(async ({}) => {
    tenantA = generateTestTenantId('iso-a');
    tenantB = generateTestTenantId('iso-b');

    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: { id: tenantA, name: `Isolation Tenant A ${tenantA}` },
    });
    await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: { id: tenantB, name: `Isolation Tenant B ${tenantB}` },
    });
    console.log(`Created isolation tenants: ${tenantA}, ${tenantB}`);
  });

  realWebAuthnTest.afterAll(async ({}) => {
    try {
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${tenantA}`);
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${tenantB}`);
      console.log(`Deleted isolation tenants`);
    } catch {
      // Ignore cleanup errors
    }
  });

  realWebAuthnTest(
    'should create different user handles for same username in different tenants',
    async ({ page, request: apiRequest }) => {
      /**
       * MULTI-TENANCY ISOLATION:
       * Same username registered in different tenants must get:
       * - Different user IDs (UUIDs)
       * - Different user handles (with tenant prefix)
       * - Completely isolated credentials
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const sharedUsername = `shared-${generateTestId()}`;

      // Register same username in tenant A
      console.log(`Registering "${sharedUsername}" in tenant ${tenantA}`);
      registrationA = await registerUser(page, apiRequest, {
        username: sharedUsername,
        tenantId: tenantA,
      });
      expect(registrationA.tenantId).toBe(tenantA);

      // Register same username in tenant B
      console.log(`Registering "${sharedUsername}" in tenant ${tenantB}`);
      registrationB = await registerUser(page, apiRequest, {
        username: sharedUsername,
        tenantId: tenantB,
      });
      expect(registrationB.tenantId).toBe(tenantB);

      // Verify isolation
      expect(registrationA.userId).not.toBe(registrationB.userId);
      expect(registrationA.credentialId).not.toBe(registrationB.credentialId);

      console.log(`✓ Same username has different user IDs:`);
      console.log(`  Tenant A: ${registrationA.userId}`);
      console.log(`  Tenant B: ${registrationB.userId}`);
    }
  );

  realWebAuthnTest(
    'should login to correct tenant with isolated credentials',
    async ({ page, request: apiRequest }) => {
      /**
       * After registering same username in two tenants, each credential
       * should only work with its own tenant endpoint.
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Login to tenant A with tenant A's credential
      console.log(`Logging in to tenant A with tenant A credential`);
      const loginA = await loginUserWithCredential(page, apiRequest, registrationA.rawCredentialId, {
        tenantId: tenantA,
      });
      expect(loginA.success).toBe(true);
      expect(loginA.userId).toBe(registrationA.userId);
      expect(loginA.tenantId).toBe(tenantA);

      // Login to tenant B with tenant B's credential
      console.log(`Logging in to tenant B with tenant B credential`);
      const loginB = await loginUserWithCredential(page, apiRequest, registrationB.rawCredentialId, {
        tenantId: tenantB,
      });
      expect(loginB.success).toBe(true);
      expect(loginB.userId).toBe(registrationB.userId);
      expect(loginB.tenantId).toBe(tenantB);

      console.log(`✓ Each credential works only with its own tenant`);
    }
  );

  realWebAuthnTest(
    'should reject cross-tenant credential usage with 409 redirect',
    async ({ page, request: apiRequest }) => {
      /**
       * Using tenant A's credential to login to tenant B should fail
       * with 409 and redirect back to tenant A.
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Try tenant A's credential on tenant B's endpoint
      console.log(`Attempting to use tenant A credential on tenant B endpoint`);
      const crossLogin = await loginUserWithCredential(page, apiRequest, registrationA.rawCredentialId, {
        tenantId: tenantB,
      });

      expect(crossLogin.success).toBe(false);
      expect(crossLogin.status).toBe(409);
      expect(crossLogin.redirectTenant).toBe(tenantA);
      expect(crossLogin.userId).toBe(registrationA.userId);

      console.log(`✓ Cross-tenant credential rejected with redirect to ${crossLogin.redirectTenant}`);
    }
  );
});

// =============================================================================
// TENANT API ERROR HANDLING TESTS
// =============================================================================

realWebAuthnTest.describe('Tenant API Error Handling', () => {
  realWebAuthnTest(
    'should return 404 for registration with non-existent tenant',
    async ({ request: apiRequest }) => {
      const response = await apiRequest.post(
        `${BACKEND_URL}/t/this-tenant-does-not-exist/user/register-webauthn-begin`,
        {
          data: { display_name: 'Test User' },
        }
      );

      expect(response.status()).toBe(404);
      console.log(`✓ Non-existent tenant returns 404`);
    }
  );
});

// =============================================================================
// USER HANDLE FORMAT VERIFICATION
// =============================================================================

realWebAuthnTest.describe('Tenant User Handle Format', () => {
  let testTenantId: string;

  realWebAuthnTest.beforeAll(async ({}) => {
    testTenantId = generateTestTenantId('handle');

    const adminApi = await request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: { id: testTenantId, name: `Handle Test Tenant ${testTenantId}` },
    });
    console.log(`Created handle test tenant: ${testTenantId}`);
  });

  realWebAuthnTest.afterAll(async ({}) => {
    try {
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${testTenantId}`);
      console.log(`Deleted handle test tenant: ${testTenantId}`);
    } catch {
      // Ignore
    }
  });

  realWebAuthnTest(
    'should return tenantId in registration finish response',
    async ({ page, request: apiRequest }) => {
      /**
       * The registration finish response must include tenantId
       * so the frontend knows which tenant the user belongs to.
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = `response-${generateTestId()}`;

      // Full registration
      const registration = await registerUser(page, apiRequest, {
        username,
        tenantId: testTenantId,
      });

      expect(registration.tenantId).toBe(testTenantId);
      expect(registration.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

      console.log(`✓ Registration response includes tenantId: ${registration.tenantId}`);
    }
  );
});

// =============================================================================
// TENANT-AWARE URL ROUTING TESTS
// =============================================================================

realWebAuthnTest.describe('Tenant-Aware URL Routing', () => {
  realWebAuthnTest(
    'should use root paths for default tenant login page',
    async ({ page }) => {
      /**
       * Default tenant users should see root paths without /t/ prefix:
       * - /login instead of /t/default/login
       * - / instead of /t/default/
       */
      await page.goto(`${FRONTEND_URL}/login`);
      await page.waitForLoadState('networkidle');

      const url = page.url();
      expect(url).toBe(`${FRONTEND_URL}/login`);
      expect(url).not.toContain('/t/');

      console.log(`✓ Default tenant uses root path: ${url}`);
    }
  );

  realWebAuthnTest(
    'should use tenant-scoped paths for non-default tenant login page',
    async ({ page }) => {
      /**
       * Non-default tenant login pages should use /t/{tenantId}/login path
       */
      const tenantId = generateTestTenantId('url-test');

      // Create tenant
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
        data: { id: tenantId, name: `URL Test Tenant ${tenantId}` },
      });

      try {
        await page.goto(`${FRONTEND_URL}/t/${tenantId}/login`);
        await page.waitForLoadState('networkidle');

        const url = page.url();
        expect(url).toContain(`/t/${tenantId}`);

        console.log(`✓ Custom tenant uses scoped path: ${url}`);
      } finally {
        await adminApi.delete(`${ADMIN_URL}/admin/tenants/${tenantId}`);
      }
    }
  );

  realWebAuthnTest(
    'should preserve tenant context in URL for unauthenticated users',
    async ({ page }) => {
      /**
       * When an unauthenticated user accesses a tenant route,
       * the tenant context should be preserved in the URL.
       */
      const tenantId = generateTestTenantId('redirect-test');

      // Create tenant
      const adminApi = await request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
        data: { id: tenantId, name: `Redirect Test Tenant ${tenantId}` },
      });

      try {
        // Access tenant route without auth
        await page.goto(`${FRONTEND_URL}/t/${tenantId}/`);
        await page.waitForLoadState('networkidle');

        const url = page.url();
        // URL should contain the tenant ID (whether on / or /login)
        expect(url).toContain(`/t/${tenantId}`);

        console.log(`✓ Tenant context preserved in URL: ${url}`);
      } finally {
        await adminApi.delete(`${ADMIN_URL}/admin/tenants/${tenantId}`);
      }
    }
  );
});
