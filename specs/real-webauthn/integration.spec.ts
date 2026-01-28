/**
 * Real WebAuthn Integration Tests - Multi-Tenancy
 *
 * @tags @real-webauthn @multi-tenancy @integration
 *
 * These tests run with real browser WebAuthn against the full
 * wallet-frontend + go-wallet-backend stack via Docker.
 *
 * Unlike CDP virtual authenticator tests, these tests:
 * - Use headed Chromium with real WebAuthn stack
 * - Exercise actual browser ↔ platform authenticator flow
 * - Test PRF extension with real (not mocked) outputs
 * - Catch bugs like userHandle extraction issues
 *
 * Prerequisites:
 *   make up  # Start Docker services
 *   npm run test:real-webauthn:integration
 *
 * Or:
 *   make test-real-webauthn
 */

import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test';
import { RealWebAuthnHelper, type WebAuthnOperationResult } from '../../helpers/real-webauthn';
import { TenantApiHelper, generateTestTenantId } from '../../helpers/tenant-api';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Extend test with real WebAuthn helper fixture
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

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

realWebAuthnTest.describe('Real WebAuthn Integration: Service Health', () => {
  realWebAuthnTest('should connect to frontend', async ({ page }) => {
    const response = await page.goto(FRONTEND_URL);
    expect(response?.ok()).toBe(true);
  });

  realWebAuthnTest('should connect to backend', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/status`);
    expect(response.ok()).toBe(true);
  });

  realWebAuthnTest('should connect to admin API', async ({ tenantApi }) => {
    const isAvailable = await tenantApi.isAvailable();
    expect(isAvailable).toBe(true);
  });
});

realWebAuthnTest.describe('Real WebAuthn Integration: Browser WebAuthn Support', () => {
  realWebAuthnTest('should have WebAuthn APIs available on frontend', async ({ page, webauthn }) => {
    await page.goto(FRONTEND_URL);

    const isSupported = await webauthn.isSupported();
    expect(isSupported).toBe(true);
  });

  realWebAuthnTest('should detect platform authenticator availability', async ({ page, webauthn }) => {
    await page.goto(FRONTEND_URL);

    const platformAvailable = await webauthn.isPlatformAuthenticatorAvailable();
    console.log(`Platform authenticator available: ${platformAvailable}`);

    // Log for debugging - don't fail if not available
    expect(typeof platformAvailable).toBe('boolean');
  });

  realWebAuthnTest('should have WebAuthn tracking initialized', async ({ page, webauthn }) => {
    await page.goto(FRONTEND_URL);

    const isPending = await webauthn.isPending();
    expect(isPending).toBe(false);

    const history = await webauthn.getOperationHistory();
    expect(history).toEqual([]);
  });
});

realWebAuthnTest.describe('Real WebAuthn Integration: Default Tenant Registration', () => {
  realWebAuthnTest('should begin registration via backend API', async ({ page, request: apiRequest }) => {
    await page.goto(FRONTEND_URL);

    const username = `user-${generateTestId()}`;

    // Begin registration with default tenant
    const beginResponse = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-begin`, {
      data: { display_name: username },
    });

    expect(beginResponse.ok()).toBe(true);

    const beginData = await beginResponse.json();
    expect(beginData.createOptions).toBeDefined();
    expect(beginData.challengeId).toBeDefined();
    expect(beginData.createOptions.publicKey.rp.id).toBe('localhost');
  });

  realWebAuthnTest('should perform full registration flow with real WebAuthn', async ({
    page,
    request: apiRequest,
  }) => {
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    const username = `user-${generateTestId()}`;

    // Step 1: Begin registration
    const beginResponse = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-begin`, {
      data: { display_name: username },
    });
    expect(beginResponse.ok()).toBe(true);

    const beginData = await beginResponse.json();
    const publicKey = beginData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Step 2: Create credential using real browser WebAuthn API
    const credentialResult = await page.evaluate(
      async (params) => {
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
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 }, // ES256
              { type: 'public-key', alg: -8 }, // EdDSA
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
        username,
        challenge: challengeB64,
      }
    );

    expect(credentialResult.id).toBeDefined();
    expect(credentialResult.type).toBe('public-key');

    // Step 3: Finish registration
    const finishResponse = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-finish`, {
      data: {
        challengeId: beginData.challengeId,
        credential: credentialResult,
        display_name: username,
      },
    });

    expect(finishResponse.ok()).toBe(true);

    const finishData = await finishResponse.json();
    expect(finishData.uuid).toBeDefined();
    expect(finishData.appToken).toBeDefined();
    expect(finishData.tenantId).toBe('default');

    console.log(`Registered user: ${finishData.uuid} in tenant: ${finishData.tenantId}`);
  });
});

realWebAuthnTest.describe('Real WebAuthn Integration: Tenant-Scoped Registration', () => {
  let testTenantId: string;

  realWebAuthnTest.beforeAll(async ({ tenantApi }) => {
    // Create a test tenant
    testTenantId = generateTestTenantId('realwebauthn');
    try {
      await tenantApi.createTenant({
        id: testTenantId,
        name: 'Real WebAuthn Test Tenant',
        display_name: 'Real WebAuthn Test',
        enabled: true,
      });
      console.log(`Created test tenant: ${testTenantId}`);
    } catch (error) {
      console.log(`Tenant creation error (may already exist): ${error}`);
    }
  });

  realWebAuthnTest.afterAll(async ({ tenantApi }) => {
    // Clean up test tenant
    try {
      await tenantApi.deleteTenant(testTenantId);
      console.log(`Deleted test tenant: ${testTenantId}`);
    } catch {
      // Ignore cleanup errors
    }
  });

  realWebAuthnTest('should register user in custom tenant with correct userHandle', async ({
    page,
    request: apiRequest,
  }) => {
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    const username = `tenant-user-${generateTestId()}`;

    // Step 1: Begin tenant-scoped registration
    const beginResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: { display_name: username },
      }
    );
    expect(beginResponse.ok()).toBe(true);

    const beginData = await beginResponse.json();
    const publicKey = beginData.createOptions.publicKey;

    // Verify the user ID is in the new binary format
    // V1 binary format: 1 byte version + 8 bytes tenant hash + 16 bytes UUID = 25 bytes
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const userIdBytes = fromBase64Url(userIdB64);

    // New binary format should be exactly 25 bytes
    expect(userIdBytes.length).toBe(25);
    // Version byte should be 0x01
    expect(userIdBytes[0]).toBe(0x01);
    console.log(`User handle length: ${userIdBytes.length} bytes (binary format v1)`);

    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Step 2: Create credential with real WebAuthn
    const credentialResult = await page.evaluate(
      async (params) => {
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
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
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
        username,
        challenge: challengeB64,
      }
    );

    // Step 3: Finish registration
    const finishResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-finish`,
      {
        data: {
          challengeId: beginData.challengeId,
          credential: credentialResult,
          display_name: username,
        },
      }
    );

    expect(finishResponse.ok()).toBe(true);

    const finishData = await finishResponse.json();
    expect(finishData.uuid).toBeDefined();
    expect(finishData.tenantId).toBe(testTenantId);

    console.log(`Registered tenant user: ${finishData.uuid} in tenant: ${finishData.tenantId}`);
  });
});

realWebAuthnTest.describe('Real WebAuthn Integration: Login with userHandle Extraction', () => {
  /**
   * This test validates the critical fix we made:
   * - Backend must NOT set UserID in session data for tenant login
   * - userHandle must be correctly extracted from authenticator response
   * - ValidateDiscoverableLogin must receive empty UserID
   */

  realWebAuthnTest('should extract userHandle during tenant-scoped login', async ({
    page,
    request: apiRequest,
  }) => {
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    const username = `login-test-${generateTestId()}`;

    // Step 1: Register a user first
    const regBegin = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-begin`, {
      data: { display_name: username },
    });
    expect(regBegin.ok()).toBe(true);

    const regBeginData = await regBegin.json();
    const publicKey = regBeginData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create credential
    const credentialResult = await page.evaluate(
      async (params) => {
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
        username,
        challenge: challengeB64,
      }
    );

    // Finish registration
    const regFinish = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-finish`, {
      data: {
        challengeId: regBeginData.challengeId,
        credential: credentialResult,
        display_name: username,
      },
    });
    expect(regFinish.ok()).toBe(true);

    const regFinishData = await regFinish.json();
    const registeredUserId = regFinishData.uuid;

    // Step 2: Now perform login
    const loginBegin = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-begin`, {
      data: {},
    });
    expect(loginBegin.ok()).toBe(true);

    const loginBeginData = await loginBegin.json();
    const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
    const rpId = loginBeginData.getOptions.publicKey.rpId;

    // Get credential assertion with real WebAuthn
    const assertionResult = await page.evaluate(
      async (params) => {
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
            // Empty allowCredentials for discoverable credential login
          },
        };

        const credential = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
        if (!credential) throw new Error('Failed to get credential');

        const response = credential.response as AuthenticatorAssertionResponse;

        // Extract userHandle - this is the critical piece
        let userHandleB64: string | null = null;
        let userHandleText: string | null = null;
        if (response.userHandle) {
          const userHandleBytes = new Uint8Array(response.userHandle);
          userHandleB64 = toBase64Url(userHandleBytes);
          try {
            userHandleText = new TextDecoder().decode(userHandleBytes);
          } catch {
            // Not UTF-8
          }
        }

        return {
          id: credential.id,
          rawId: { $b64u: toBase64Url(new Uint8Array(credential.rawId)) },
          type: credential.type,
          response: {
            clientDataJSON: { $b64u: toBase64Url(new Uint8Array(response.clientDataJSON)) },
            authenticatorData: { $b64u: toBase64Url(new Uint8Array(response.authenticatorData)) },
            signature: { $b64u: toBase64Url(new Uint8Array(response.signature)) },
            userHandle: response.userHandle ? { $b64u: userHandleB64 } : null,
          },
          clientExtensionResults: credential.getClientExtensionResults(),
          // For debugging
          _userHandleText: userHandleText,
        };
      },
      {
        rpId,
        challenge: loginChallenge,
      }
    );

    // Verify userHandle was returned
    expect(assertionResult.response.userHandle).toBeDefined();
    // User handle is now in binary format (25 bytes), not string format
    // Binary format: 1 byte version (0x01) + 8 bytes tenant hash + 16 bytes UUID
    const userHandleB64 = assertionResult.response.userHandle!.$b64u;
    const userHandleBytes = fromBase64Url(userHandleB64!);
    expect(userHandleBytes.length).toBe(25);
    expect(userHandleBytes[0]).toBe(0x01); // Version 1
    console.log(`Login userHandle: ${userHandleBytes.length} bytes, version: ${userHandleBytes[0]}`);

    // Finish login
    const loginFinish = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-finish`, {
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

    // THIS IS THE CRITICAL CHECK
    // With our fix, this should succeed because:
    // - Backend doesn't set UserID in session data
    // - userHandle is correctly extracted and parsed
    // - ValidateDiscoverableLogin finds the user via userHandle
    expect(loginFinish.ok()).toBe(true);

    const loginFinishData = await loginFinish.json();
    expect(loginFinishData.uuid).toBe(registeredUserId);
    expect(loginFinishData.tenantId).toBe('default');

    console.log(`Login successful! User: ${loginFinishData.uuid}, Tenant: ${loginFinishData.tenantId}`);
  });
});

realWebAuthnTest.describe('Real WebAuthn Integration: UI-Driven Registration', () => {
  realWebAuthnTest('should complete registration through frontend UI', async ({ page, webauthn }) => {
    await page.goto(FRONTEND_URL);

    // Wait for the app to load
    await page.waitForLoadState('networkidle');

    // Look for signup/register button or link
    const signupButton = page.getByRole('button', { name: /sign up|register|create account/i });
    const signupLink = page.getByRole('link', { name: /sign up|register|create account/i });

    const hasSignup = (await signupButton.count()) > 0 || (await signupLink.count()) > 0;

    if (!hasSignup) {
      console.log('No signup button found on homepage - skipping UI test');
      realWebAuthnTest.skip();
      return;
    }

    // Click signup
    if ((await signupButton.count()) > 0) {
      await signupButton.click();
    } else {
      await signupLink.click();
    }

    // Wait for registration form or WebAuthn prompt
    await page.waitForTimeout(1000);

    // The WebAuthn prompt should trigger
    // Our tracking will capture it
    const isPending = await webauthn.isPending();
    const history = await webauthn.getOperationHistory();

    console.log(`WebAuthn pending: ${isPending}, history length: ${history.length}`);
  });
});

/**
 * Tenant Discovery and Redirect Tests
 *
 * These tests verify the critical multi-tenancy behavior:
 * 1. Tenant is ALWAYS discovered from the passkey credential (userHandle)
 * 2. Cross-tenant login attempts return 409 with redirect_tenant field
 * 3. Default tenant accepts users with empty/default tenant hash
 */
realWebAuthnTest.describe('Real WebAuthn Integration: Tenant Discovery and Redirect', () => {
  let testTenantId: string;
  let tenantUserCredential: any;
  let tenantUserId: string;

  realWebAuthnTest.beforeAll(async ({ request: apiRequest }) => {
    testTenantId = `redirect-test-${generateTestId()}`;
    const adminApi = await request.newContext({
      extraHTTPHeaders: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
    });

    // Create a test tenant
    const createResponse = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: {
        id: testTenantId,
        name: `Redirect Test Tenant ${testTenantId}`,
      },
    });
    expect(createResponse.ok()).toBe(true);
    console.log(`Created test tenant: ${testTenantId}`);
  });

  realWebAuthnTest.afterAll(async ({}) => {
    try {
      const adminApi = await request.newContext({
        extraHTTPHeaders: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
        },
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
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    const username = `redirect-user-${generateTestId()}`;

    // Register in the custom tenant
    const beginResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      { data: { display_name: username } }
    );
    expect(beginResponse.ok()).toBe(true);

    const beginData = await beginResponse.json();
    const publicKey = beginData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create credential
    const credentialResult = await page.evaluate(
      async (params) => {
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
        username,
        challenge: challengeB64,
      }
    );

    // Finish registration
    const finishResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-finish`,
      {
        data: {
          challengeId: beginData.challengeId,
          credential: credentialResult,
          display_name: username,
        },
      }
    );
    expect(finishResponse.ok()).toBe(true);

    const finishData = await finishResponse.json();
    expect(finishData.tenantId).toBe(testTenantId);

    // Store credential info for subsequent tests
    tenantUserCredential = credentialResult;
    tenantUserId = finishData.uuid;

    console.log(`Registered user ${tenantUserId} in tenant ${testTenantId} for redirect tests`);
  });

  realWebAuthnTest('should return 409 with redirect_tenant when tenant user logs in via global endpoint', async ({
    page,
    request: apiRequest,
  }) => {
    /**
     * KEY TEST: Tenant discovery behavior
     *
     * When a user registered in tenant X tries to login via the global
     * endpoint (no tenant in URL), the backend should:
     * 1. Extract user ID from the userHandle
     * 2. Look up user's tenant membership
     * 3. Return 409 with redirect_tenant field pointing to tenant X
     *
     * This allows the frontend to redirect to the correct tenant's login flow.
     */
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    // Begin login via GLOBAL endpoint
    const loginBegin = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-begin`, {
      data: {},
    });
    expect(loginBegin.ok()).toBe(true);

    const loginBeginData = await loginBegin.json();
    const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
    const rpId = loginBeginData.getOptions.publicKey.rpId;

    // Get assertion using the tenant user's credential
    const assertionResult = await page.evaluate(
      async (params) => {
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
            // Empty allowCredentials for discoverable credential flow
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
          _userHandleLength: userHandleBytes?.length,
        };
      },
      { rpId, challenge: loginChallenge }
    );

    // Verify userHandle is in binary format (25 bytes)
    expect(assertionResult._userHandleLength).toBe(25);

    // Finish login - should get 409 with redirect_tenant
    const loginFinish = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-finish`, {
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

    // CRITICAL: Should return 409 Conflict with redirect information
    expect(loginFinish.status()).toBe(409);

    const errorData = await loginFinish.json();
    expect(errorData.error).toBe('Tenant redirect required');
    expect(errorData.redirect_tenant).toBe(testTenantId);
    expect(errorData.user_id).toBe(tenantUserId);

    console.log(`Got expected 409 redirect to tenant: ${errorData.redirect_tenant}`);
  });

  realWebAuthnTest('should return 409 when tenant user logs in via wrong tenant endpoint', async ({
    page,
    request: apiRequest,
  }) => {
    /**
     * KEY TEST: Cross-tenant redirect
     *
     * When a user registered in tenant X tries to login via tenant Y's
     * endpoint, the backend should return 409 with the correct tenant X.
     */
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    // Create another tenant for cross-tenant test
    const adminApi = await request.newContext({
      extraHTTPHeaders: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
    });
    const wrongTenantId = `wrong-tenant-${generateTestId()}`;

    const createResponse = await adminApi.post(`${ADMIN_URL}/admin/tenants`, {
      data: {
        id: wrongTenantId,
        name: `Wrong Tenant ${wrongTenantId}`,
      },
    });
    expect(createResponse.ok()).toBe(true);

    try {
      // Begin login via WRONG tenant endpoint
      const loginBegin = await apiRequest.post(
        `${BACKEND_URL}/t/${wrongTenantId}/user/login-webauthn-begin`,
        { data: {} }
      );
      expect(loginBegin.ok()).toBe(true);

      const loginBeginData = await loginBegin.json();
      const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
      const rpId = loginBeginData.getOptions.publicKey.rpId;

      // Get assertion using the original tenant user's credential
      const assertionResult = await page.evaluate(
        async (params) => {
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
        { rpId, challenge: loginChallenge }
      );

      // Finish login via wrong tenant - should get 409 with redirect to correct tenant
      const loginFinish = await apiRequest.post(
        `${BACKEND_URL}/t/${wrongTenantId}/user/login-webauthn-finish`,
        {
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
        }
      );

      // CRITICAL: Should return 409 with redirect to CORRECT tenant
      expect(loginFinish.status()).toBe(409);

      const errorData = await loginFinish.json();
      expect(errorData.error).toBe('Tenant redirect required');
      expect(errorData.redirect_tenant).toBe(testTenantId); // Correct tenant
      expect(errorData.redirect_tenant).not.toBe(wrongTenantId); // Not wrong tenant
      expect(errorData.user_id).toBe(tenantUserId);

      console.log(
        `Got expected 409 redirect from wrong tenant ${wrongTenantId} to correct tenant: ${errorData.redirect_tenant}`
      );
    } finally {
      // Cleanup wrong tenant
      await adminApi.delete(`${ADMIN_URL}/admin/tenants/${wrongTenantId}`);
    }
  });

  realWebAuthnTest('should allow default tenant user to login via global endpoint', async ({
    page,
    request: apiRequest,
  }) => {
    /**
     * KEY TEST: Default tenant accepts global logins
     *
     * Users registered in the "default" tenant should be able to login
     * via the global endpoint (no /t/tenantId prefix) successfully.
     */
    await page.goto(FRONTEND_URL);
    // Wait for frontend to finish any initial navigation/redirects
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Extra buffer for React hydration

    const username = `default-user-${generateTestId()}`;

    // Register in default tenant (global endpoint)
    const regBegin = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-begin`, {
      data: { display_name: username },
    });
    expect(regBegin.ok()).toBe(true);

    const regBeginData = await regBegin.json();
    const publicKey = regBeginData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create credential
    const credentialResult = await page.evaluate(
      async (params) => {
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
        username,
        challenge: challengeB64,
      }
    );

    // Finish registration
    const regFinish = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-finish`, {
      data: {
        challengeId: regBeginData.challengeId,
        credential: credentialResult,
        display_name: username,
      },
    });
    expect(regFinish.ok()).toBe(true);

    const regFinishData = await regFinish.json();
    const defaultUserId = regFinishData.uuid;

    // Now login via global endpoint
    const loginBegin = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-begin`, {
      data: {},
    });
    expect(loginBegin.ok()).toBe(true);

    const loginBeginData = await loginBegin.json();
    const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
    const rpId = loginBeginData.getOptions.publicKey.rpId;

    // Get assertion
    const assertionResult = await page.evaluate(
      async (params) => {
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
      { rpId, challenge: loginChallenge }
    );

    // Finish login - should succeed (200 OK, not 409)
    const loginFinish = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-finish`, {
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

    // Default tenant user should login successfully via global endpoint
    expect(loginFinish.ok()).toBe(true);

    const loginFinishData = await loginFinish.json();
    expect(loginFinishData.uuid).toBe(defaultUserId);
    expect(loginFinishData.tenantId).toBe('default');

    console.log(`Default tenant user ${defaultUserId} logged in successfully via global endpoint`);
  });
});
