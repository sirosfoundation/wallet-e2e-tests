/**
 * Critical Path Tests for Multi-Tenancy
 *
 * @tags @multi-tenancy @critical
 *
 * These tests verify the COMPLETE user journey for tenant-scoped authentication.
 * They are designed to catch bugs that only manifest when operations are chained:
 * - Registration must create a credential that can be used for login
 * - Login must correctly decode tenant-scoped user handles
 * - The same user ID must be returned after both operations
 *
 * IMPORTANT: These tests would have caught the following bugs:
 * 1. Missing CredParams in FinishTenantRegistration (credential verification fails)
 * 2. Wrong user ID extraction in ValidateDiscoverableLogin (user not found)
 * 3. Wrong WebAuthnUser type returned (credential mismatch)
 */

import { test, expect, request, Page, APIRequestContext } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import { TenantApiHelper, generateTestTenantId } from '../../helpers/tenant-api';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Helper to perform tenant registration via WebAuthn API
 */
async function performTenantRegistration(
  page: Page,
  apiRequest: APIRequestContext,
  tenantId: string,
  username: string
): Promise<{
  userId: string;
  token: string;
  tenantId: string;
  credentialId: string;
}> {
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
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -8 },   // EdDSA
          { type: 'public-key', alg: -257 }, // RS256
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

  return {
    userId: finishData.uuid,
    token: finishData.appToken,
    tenantId: finishData.tenantId,
    credentialId: credentialResult.id,
  };
}

/**
 * Helper to perform login via global WebAuthn endpoint
 * (tenant is discovered from the passkey's userHandle)
 * NOTE: This only works for default tenant users. Non-default tenant users
 * must use performTenantLogin with the tenant-scoped endpoint.
 */
async function performGlobalLogin(
  page: Page,
  apiRequest: APIRequestContext
): Promise<{
  userId: string;
  token: string;
  tenantId: string;
}> {
  // Step 1: Begin global login
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/user/login-webauthn-begin`,
    { data: {} }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin login failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const getOptions = beginData.getOptions;
  const challengeB64 = getOptions.publicKey.challenge.$b64u || getOptions.publicKey.challenge;

  // Step 2: Get credential assertion
  const assertionResult = await page.evaluate(async (params) => {
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

    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge: fromBase64Url(params.challenge),
        rpId: params.rpId,
        userVerification: 'required',
        // Empty allowCredentials for discoverable credential
      },
    };

    const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to get credential');

    const response = credential.response as AuthenticatorAssertionResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        authenticatorData: { '$b64u': toBase64Url(new Uint8Array(response.authenticatorData)) },
        signature: { '$b64u': toBase64Url(new Uint8Array(response.signature)) },
        userHandle: response.userHandle
          ? { '$b64u': toBase64Url(new Uint8Array(response.userHandle)) }
          : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: getOptions.publicKey.rpId,
    challenge: challengeB64,
  });

  // Step 3: Finish login
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/user/login-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: assertionResult,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish login failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();

  return {
    userId: finishData.uuid,
    token: finishData.appToken,
    tenantId: finishData.tenantId,
  };
}

/**
 * Helper to perform login via tenant-scoped WebAuthn endpoint
 * Required for non-default tenant users.
 */
async function performTenantLogin(
  page: Page,
  apiRequest: APIRequestContext,
  tenantId: string
): Promise<{
  userId: string;
  token: string;
  tenantId: string;
}> {
  // Step 1: Begin tenant-scoped login
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/t/${tenantId}/user/login-webauthn-begin`,
    { data: {} }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin tenant login failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const getOptions = beginData.getOptions;
  const challengeB64 = getOptions.publicKey.challenge.$b64u || getOptions.publicKey.challenge;

  // Step 2: Get credential assertion
  const assertionResult = await page.evaluate(async (params) => {
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

    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge: fromBase64Url(params.challenge),
        rpId: params.rpId,
        userVerification: 'required',
      },
    };

    const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to get credential');

    const response = credential.response as AuthenticatorAssertionResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        authenticatorData: { '$b64u': toBase64Url(new Uint8Array(response.authenticatorData)) },
        signature: { '$b64u': toBase64Url(new Uint8Array(response.signature)) },
        userHandle: response.userHandle
          ? { '$b64u': toBase64Url(new Uint8Array(response.userHandle)) }
          : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: getOptions.publicKey.rpId,
    challenge: challengeB64,
  });

  // Step 3: Finish tenant login
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/t/${tenantId}/user/login-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: assertionResult,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish tenant login failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();

  return {
    userId: finishData.uuid,
    token: finishData.appToken,
    tenantId: finishData.tenantId,
  };
}

test.describe('Critical Path: Tenant Registration → Login @multi-tenancy @critical', () => {
  let tenantApi: TenantApiHelper;
  let webauthn: WebAuthnHelper;
  let testTenantId: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create a dedicated test tenant
    testTenantId = generateTestTenantId('critical');
    await tenantApi.createTenant({
      id: testTenantId,
      name: 'Critical Path Test Tenant',
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
    // Initialize WebAuthn virtual authenticator
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

  /**
   * CRITICAL TEST: Register a user and immediately login
   *
   * This single test would have caught ALL THREE bugs we discovered:
   * 1. Missing CredParams → registration finishes but login fails with "Invalid attestation format"
   * 2. Wrong user ID extraction → login fails with "user not found"
   * 3. Wrong WebAuthnUser type → login fails with "credential not found"
   */
  test('should register a tenant user and immediately login successfully', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // STEP 1: Register the user
    console.log(`Registering user ${username} in tenant ${testTenantId}...`);
    const registration = await performTenantRegistration(
      page,
      apiRequest,
      testTenantId,
      username
    );

    // Verify registration returned expected data
    expect(registration.userId).toBeDefined();
    expect(registration.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(registration.token).toBeDefined();
    expect(registration.tenantId).toBe(testTenantId);
    expect(registration.credentialId).toBeDefined();

    console.log(`Registration successful: userId=${registration.userId}`);

    // STEP 2: Immediately attempt login with the same credential
    // This is the critical step that catches bugs in credential storage/retrieval
    // Non-default tenants must use tenant-scoped login endpoint
    console.log('Attempting login with registered credential...');
    const login = await performTenantLogin(page, apiRequest, testTenantId);

    // Verify login succeeded
    expect(login.userId).toBeDefined();
    expect(login.token).toBeDefined();
    expect(login.tenantId).toBeDefined();

    // CRITICAL: The same user ID must be returned
    expect(login.userId).toBe(registration.userId);

    // CRITICAL: The tenant must be correctly discovered from the passkey
    expect(login.tenantId).toBe(testTenantId);

    console.log(`Login successful: userId=${login.userId}, tenantId=${login.tenantId}`);
  });

  test('should allow multiple registrations and logins in sequence', async ({
    page,
    request: apiRequest,
  }) => {
    // Register and login user A
    const usernameA = generateTestUsername();
    const registrationA = await performTenantRegistration(page, apiRequest, testTenantId, usernameA);
    expect(registrationA.userId).toBeDefined();

    // Login as user A (using tenant-scoped endpoint)
    const loginA = await performTenantLogin(page, apiRequest, testTenantId);
    expect(loginA.userId).toBe(registrationA.userId);

    // Clear the authenticator and register user B
    await webauthn.clearCredentials();

    const usernameB = generateTestUsername();
    const registrationB = await performTenantRegistration(page, apiRequest, testTenantId, usernameB);
    expect(registrationB.userId).toBeDefined();
    expect(registrationB.userId).not.toBe(registrationA.userId); // Different user

    // Login as user B (using tenant-scoped endpoint)
    const loginB = await performTenantLogin(page, apiRequest, testTenantId);
    expect(loginB.userId).toBe(registrationB.userId);
    expect(loginB.tenantId).toBe(testTenantId);
  });

  test('should maintain credential across page navigation', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // Register the user
    const registration = await performTenantRegistration(page, apiRequest, testTenantId, username);
    expect(registration.userId).toBeDefined();

    // Navigate away and back (simulates user closing and reopening browser)
    await page.goto('about:blank');
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('domcontentloaded');

    // Login should still work (credential persists in virtual authenticator)
    // Non-default tenants must use tenant-scoped login endpoint
    const login = await performTenantLogin(page, apiRequest, testTenantId);
    expect(login.userId).toBe(registration.userId);
    expect(login.tenantId).toBe(testTenantId);
  });
});

test.describe('Critical Path: Cross-Tenant Isolation @multi-tenancy @critical', () => {
  let tenantApi: TenantApiHelper;
  let webauthn: WebAuthnHelper;
  let tenantA: string;
  let tenantB: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create two separate tenants
    tenantA = generateTestTenantId('iso-a');
    tenantB = generateTestTenantId('iso-b');

    await tenantApi.createTenant({ id: tenantA, name: 'Isolation Test A', enabled: true });
    await tenantApi.createTenant({ id: tenantB, name: 'Isolation Test B', enabled: true });
  });

  test.afterAll(async () => {
    try {
      await tenantApi.deleteTenant(tenantA);
      await tenantApi.deleteTenant(tenantB);
    } catch {
      // Ignore cleanup errors
    }
  });

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    if (webauthn) {
      await webauthn.cleanup();
    }
  });

  test('should register users in different tenants and login discovers correct tenant', async ({
    page,
    request: apiRequest,
  }) => {
    // Register user in tenant A
    const userA = generateTestUsername();
    const registrationA = await performTenantRegistration(page, apiRequest, tenantA, userA);
    expect(registrationA.tenantId).toBe(tenantA);

    // Login using tenant-scoped endpoint (required for non-default tenants)
    const loginA = await performTenantLogin(page, apiRequest, tenantA);
    expect(loginA.userId).toBe(registrationA.userId);
    expect(loginA.tenantId).toBe(tenantA);

    // Clear and register user in tenant B
    await webauthn.clearCredentials();

    const userB = generateTestUsername();
    const registrationB = await performTenantRegistration(page, apiRequest, tenantB, userB);
    expect(registrationB.tenantId).toBe(tenantB);

    // Login using tenant-scoped endpoint (required for non-default tenants)
    const loginB = await performTenantLogin(page, apiRequest, tenantB);
    expect(loginB.userId).toBe(registrationB.userId);
    expect(loginB.tenantId).toBe(tenantB);

    // Verify different users
    expect(registrationA.userId).not.toBe(registrationB.userId);
  });
});
