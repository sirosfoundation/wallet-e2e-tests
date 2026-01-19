/**
 * Multi-Tenancy E2E Tests
 *
 * @tags @multi-tenancy
 *
 * Tests the multi-tenancy features of go-wallet-backend:
 * - Tenant-scoped WebAuthn registration and login
 * - User handle tenant prefixing (tenantID:userID format)
 * - Cross-tenant credential isolation
 * - Tenant management via admin API
 */

import { test, expect, request } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';
import {
  TenantApiHelper,
  decodeUserHandle,
  generateTestTenantId,
} from '../../helpers/tenant-api';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';

test.describe('Multi-Tenancy Admin API @multi-tenancy', () => {
  let tenantApi: TenantApiHelper;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);
  });

  test.afterAll(async () => {
    // Clean up test tenants
    try {
      await tenantApi.cleanupTestTenants();
    } catch {
      // Ignore cleanup errors
    }
  });

  test('should verify admin API is available', async () => {
    const isAvailable = await tenantApi.isAvailable();
    expect(isAvailable).toBe(true);

    const status = await tenantApi.getStatus();
    expect(status.status).toBe('ok');
    expect(status.service).toBe('wallet-backend-admin');
  });

  test('should create a new tenant', async () => {
    const tenantId = generateTestTenantId('create');
    const tenant = await tenantApi.createTenant({
      id: tenantId,
      name: 'Test Tenant',
      display_name: 'Test Tenant Display Name',
      enabled: true,
    });

    expect(tenant.id).toBe(tenantId);
    expect(tenant.name).toBe('Test Tenant');
    expect(tenant.enabled).toBe(true);

    // Clean up
    await tenantApi.deleteTenant(tenantId);
  });

  test('should list tenants', async () => {
    // Create a tenant to ensure at least one exists
    const tenantId = generateTestTenantId('list');
    await tenantApi.createTenant({
      id: tenantId,
      name: 'List Test Tenant',
      enabled: true,
    });

    const tenants = await tenantApi.listTenants();
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.some(t => t.id === tenantId)).toBe(true);

    // Clean up
    await tenantApi.deleteTenant(tenantId);
  });

  test('should get tenant by ID', async () => {
    const tenantId = generateTestTenantId('get');
    await tenantApi.createTenant({
      id: tenantId,
      name: 'Get Test Tenant',
      enabled: true,
    });

    const tenant = await tenantApi.getTenant(tenantId);
    expect(tenant).not.toBeNull();
    expect(tenant?.id).toBe(tenantId);
    expect(tenant?.name).toBe('Get Test Tenant');

    // Clean up
    await tenantApi.deleteTenant(tenantId);
  });

  test('should return null for non-existent tenant', async () => {
    const tenant = await tenantApi.getTenant('non-existent-tenant-id');
    expect(tenant).toBeNull();
  });

  test('should update tenant', async () => {
    const tenantId = generateTestTenantId('update');
    await tenantApi.createTenant({
      id: tenantId,
      name: 'Original Name',
      enabled: true,
    });

    const updated = await tenantApi.updateTenant(tenantId, {
      name: 'Updated Name',
      display_name: 'New Display Name',
    });

    expect(updated.name).toBe('Updated Name');
    expect(updated.display_name).toBe('New Display Name');

    // Clean up
    await tenantApi.deleteTenant(tenantId);
  });

  test('should enable and disable tenant', async () => {
    const tenantId = generateTestTenantId('toggle');
    await tenantApi.createTenant({
      id: tenantId,
      name: 'Toggle Test',
      enabled: true,
    });

    // Disable
    const disabled = await tenantApi.disableTenant(tenantId);
    expect(disabled.enabled).toBe(false);

    // Enable
    const enabled = await tenantApi.enableTenant(tenantId);
    expect(enabled.enabled).toBe(true);

    // Clean up
    await tenantApi.deleteTenant(tenantId);
  });

  test('should delete tenant', async () => {
    const tenantId = generateTestTenantId('delete');
    await tenantApi.createTenant({
      id: tenantId,
      name: 'Delete Test',
      enabled: true,
    });

    await tenantApi.deleteTenant(tenantId);

    const tenant = await tenantApi.getTenant(tenantId);
    expect(tenant).toBeNull();
  });
});

test.describe('Tenant-Scoped WebAuthn API @multi-tenancy', () => {
  let tenantApi: TenantApiHelper;
  let testTenantId: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create a test tenant
    testTenantId = generateTestTenantId('webauthn');
    await tenantApi.createTenant({
      id: testTenantId,
      name: 'WebAuthn Test Tenant',
      enabled: true,
    });
  });

  test.afterAll(async () => {
    // Clean up
    try {
      await tenantApi.deleteTenant(testTenantId);
    } catch {
      // Ignore
    }
  });

  test('should begin tenant-scoped registration', async ({ request: apiRequest }) => {
    const username = generateTestUsername();

    const response = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );

    expect(response.status()).toBe(200);

    const body = await response.json();
    // Response format: { createOptions: { publicKey: { ... } } }
    expect(body.createOptions).toBeDefined();
    expect(body.createOptions.publicKey).toBeDefined();
    expect(body.createOptions.publicKey.rp).toBeDefined();
    expect(body.createOptions.publicKey.user).toBeDefined();
    expect(body.createOptions.publicKey.challenge).toBeDefined();
  });

  test('should reject registration for non-existent tenant', async ({ request: apiRequest }) => {
    const response = await apiRequest.post(
      `${BACKEND_URL}/t/non-existent-tenant/user/register-webauthn-begin`,
      {
        data: {
          name: 'test-user',
          display_name: 'Test User',
          wallet_type: 'client-device',
        },
      }
    );

    expect(response.status()).toBe(404);
  });

  test('should reject registration for disabled tenant', async ({ request: apiRequest }) => {
    // Disable the tenant
    await tenantApi.disableTenant(testTenantId);

    const response = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          name: 'test-user',
          display_name: 'Test User',
          wallet_type: 'client-device',
        },
      }
    );

    expect(response.status()).toBe(403);

    // Re-enable for other tests
    await tenantApi.enableTenant(testTenantId);
  });
});

test.describe('Tenant User Handle Prefixing @multi-tenancy', () => {
  let tenantApi: TenantApiHelper;
  let webauthn: WebAuthnHelper;
  let testTenantId: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    testTenantId = generateTestTenantId('prefix');
    await tenantApi.createTenant({
      id: testTenantId,
      name: 'Prefix Test Tenant',
      enabled: true,
    });
  });

  test.afterAll(async () => {
    try {
      await tenantApi.deleteTenant(testTenantId);
    } catch {
      // Ignore
    }
  });

  test('should include tenant prefix in user handle', async ({ page, request: apiRequest }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    const username = generateTestUsername();

    // Start registration to get the user handle
    const beginResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );

    expect(beginResponse.status()).toBe(200);

    const options = await beginResponse.json();

    // Response format: { createOptions: { publicKey: { user: { id: { $b64u: "..." } } } } }
    const publicKey = options.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    expect(userIdB64).toBeDefined();

    // Decode and verify it contains the tenant prefix
    const decoded = decodeUserHandle(userIdB64);
    expect(decoded).not.toBeNull();
    expect(decoded?.tenantId).toBe(testTenantId);
    expect(decoded?.userId).toBeDefined();
    // UUID format check: should have 36 characters with hyphens
    expect(decoded?.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

    await webauthn.cleanup();
  });

  test('should have consistent user handle format across registration requests', async ({
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // Start two registrations for the same user
    const response1 = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(response1.status()).toBe(200);

    const options1 = await response1.json();
    const publicKey1 = options1.createOptions.publicKey;
    const userIdB64_1 = publicKey1.user.id.$b64u || publicKey1.user.id;
    const decoded1 = decodeUserHandle(userIdB64_1);

    // Start second registration for same username (simulates retry)
    const response2 = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(response2.status()).toBe(200);

    const options2 = await response2.json();
    const publicKey2 = options2.createOptions.publicKey;
    const userIdB64_2 = publicKey2.user.id.$b64u || publicKey2.user.id;
    const decoded2 = decodeUserHandle(userIdB64_2);

    // Both should have the same tenant prefix
    expect(decoded1?.tenantId).toBe(testTenantId);
    expect(decoded2?.tenantId).toBe(testTenantId);

    // Both should be valid UUIDs
    expect(decoded1?.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(decoded2?.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  });
});

test.describe('Cross-Tenant Credential Isolation @multi-tenancy', () => {
  let tenantApi: TenantApiHelper;
  let tenantA: string;
  let tenantB: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create two separate tenants
    tenantA = generateTestTenantId('tenant-a');
    tenantB = generateTestTenantId('tenant-b');

    await tenantApi.createTenant({
      id: tenantA,
      name: 'Tenant A',
      enabled: true,
    });

    await tenantApi.createTenant({
      id: tenantB,
      name: 'Tenant B',
      enabled: true,
    });
  });

  test.afterAll(async () => {
    try {
      await tenantApi.deleteTenant(tenantA);
      await tenantApi.deleteTenant(tenantB);
    } catch {
      // Ignore
    }
  });

  test('should have different user handles for same username in different tenants', async ({
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // Register in tenant A
    const responseA = await apiRequest.post(
      `${BACKEND_URL}/t/${tenantA}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(responseA.status()).toBe(200);

    const optionsA = await responseA.json();
    // Response format: { createOptions: { publicKey: { ... } } }
    const publicKeyA = optionsA.createOptions.publicKey;
    const userIdA = publicKeyA.user.id.$b64u || publicKeyA.user.id;
    const decodedA = decodeUserHandle(userIdA);

    // Register in tenant B
    const responseB = await apiRequest.post(
      `${BACKEND_URL}/t/${tenantB}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(responseB.status()).toBe(200);

    const optionsB = await responseB.json();
    const publicKeyB = optionsB.createOptions.publicKey;
    const userIdB = publicKeyB.user.id.$b64u || publicKeyB.user.id;
    const decodedB = decodeUserHandle(userIdB);

    // Verify different tenant prefixes
    expect(decodedA?.tenantId).toBe(tenantA);
    expect(decodedB?.tenantId).toBe(tenantB);

    // User IDs should be different (even for same username)
    expect(userIdA).not.toBe(userIdB);

    // But both should be valid UUIDs
    expect(decodedA?.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(decodedB?.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  });

  test('should have independent challenges per tenant', async ({ request: apiRequest }) => {
    const username = generateTestUsername();

    // Start registration with tenant A
    const responseA = await apiRequest.post(
      `${BACKEND_URL}/t/${tenantA}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(responseA.status()).toBe(200);

    const optionsA = await responseA.json();
    const challengeA = optionsA.createOptions.publicKey.challenge.$b64u;

    // Start registration with tenant B (same username)
    const responseB = await apiRequest.post(
      `${BACKEND_URL}/t/${tenantB}/user/register-webauthn-begin`,
      {
        data: {
          name: username,
          display_name: username,
          wallet_type: 'client-device',
        },
      }
    );
    expect(responseB.status()).toBe(200);

    const optionsB = await responseB.json();
    const challengeB = optionsB.createOptions.publicKey.challenge.$b64u;

    // Challenges should be different for different tenants
    expect(challengeA).not.toBe(challengeB);
  });
});

test.describe('User Handle Decoding Utility @multi-tenancy', () => {
  test('should decode valid tenant:user handles', () => {
    // Encode "test-tenant:123e4567-e89b-12d3-a456-426614174000"
    const input = btoa('test-tenant:123e4567-e89b-12d3-a456-426614174000')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const result = decodeUserHandle(input);
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe('test-tenant');
    expect(result?.userId).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  test('should return null for non-tenant format handles', () => {
    // Just a plain UUID without tenant prefix
    const input = btoa('123e4567-e89b-12d3-a456-426614174000')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const result = decodeUserHandle(input);
    expect(result).toBeNull();
  });

  test('should handle special characters in tenant IDs', () => {
    // Tenant ID with hyphens
    const input = btoa('my-test-tenant:123e4567-e89b-12d3-a456-426614174000')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const result = decodeUserHandle(input);
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe('my-test-tenant');
  });
});

test.describe('Tenant ID in Login/Registration Responses @multi-tenancy', () => {
  let tenantApi: TenantApiHelper;
  let webauthn: WebAuthnHelper;
  let testTenantId: string;

  test.beforeAll(async () => {
    const apiContext = await request.newContext();
    tenantApi = new TenantApiHelper(apiContext, ADMIN_URL);

    // Create a test tenant for this suite
    testTenantId = generateTestTenantId('response');
    await tenantApi.createTenant({
      id: testTenantId,
      name: 'Response Test Tenant',
      enabled: true,
    });
  });

  test.afterAll(async () => {
    try {
      await tenantApi.deleteTenant(testTenantId);
    } catch {
      // Ignore
    }
  });

  test('should return tenantId in tenant-scoped registration finish response', async ({
    page,
    request: apiRequest,
  }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    const username = generateTestUsername();

    // Step 1: Begin tenant-scoped registration
    const beginResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: {
          display_name: username,
        },
      }
    );

    expect(beginResponse.status()).toBe(200);
    const beginData = await beginResponse.json();

    // Step 2: Create credential via CDP (simulating browser WebAuthn)
    // The CDP virtual authenticator will create the credential
    const publicKey = beginData.createOptions.publicKey;

    // Get the user ID and challenge
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create the credential using the page's WebAuthn API
    const credentialResult = await page.evaluate(async (params) => {
      const { publicKeyOptions } = params;

      // Decode the user.id and challenge from base64url
      function fromBase64Url(b64u: string): Uint8Array {
        const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
        const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
        const binary = atob(paddedBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function toBase64Url(bytes: Uint8Array): string {
        const binary = String.fromCharCode(...bytes);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }

      // Generate PRF salt in browser context
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));

      const createOptions: CredentialCreationOptions = {
        publicKey: {
          rp: publicKeyOptions.rp,
          user: {
            id: fromBase64Url(publicKeyOptions.user.id),
            name: publicKeyOptions.user.name,
            displayName: publicKeyOptions.user.displayName,
          },
          challenge: fromBase64Url(publicKeyOptions.challenge),
          pubKeyCredParams: publicKeyOptions.pubKeyCredParams,
          authenticatorSelection: publicKeyOptions.authenticatorSelection,
          attestation: publicKeyOptions.attestation || 'direct',
          extensions: {
            prf: {
              eval: {
                first: prfSalt,
              },
            },
          },
        },
      };

      const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential;
      if (!credential) {
        throw new Error('Failed to create credential');
      }

      const response = credential.response as AuthenticatorAttestationResponse;

      return {
        type: credential.type,
        id: credential.id,
        rawId: toBase64Url(new Uint8Array(credential.rawId)),
        response: {
          attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          transports: response.getTransports?.() || ['internal'],
        },
        authenticatorAttachment: credential.authenticatorAttachment || 'platform',
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    }, {
      publicKeyOptions: {
        rp: publicKey.rp,
        user: {
          id: userIdB64,
          name: username,
          displayName: username,
        },
        challenge: challengeB64,
        pubKeyCredParams: publicKey.pubKeyCredParams,
        authenticatorSelection: publicKey.authenticatorSelection,
        attestation: publicKey.attestation,
      },
    });

    // Step 3: Finish registration
    const finishResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-finish`,
      {
        data: {
          challengeId: beginData.challengeId,
          displayName: username,
          privateData: null,  // Would normally be encrypted container
          credential: credentialResult,
        },
      }
    );

    expect(finishResponse.status()).toBe(200);
    const finishData = await finishResponse.json();

    // CRITICAL: Verify tenantId is returned in response
    expect(finishData.tenantId).toBeDefined();
    expect(finishData.tenantId).toBe(testTenantId);

    // Also verify other response fields
    expect(finishData.uuid).toBeDefined();
    expect(finishData.appToken).toBeDefined();

    await webauthn.cleanup();
  });

  test('should return tenantId in global login finish response for tenant user', async ({
    page,
    request: apiRequest,
  }) => {
    // This test requires a registered user to exist
    // We'll register a new user first, then test global login

    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    const username = generateTestUsername();

    // First, register a user in the tenant
    const beginRegResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
      {
        data: { display_name: username },
      }
    );
    expect(beginRegResponse.status()).toBe(200);
    const beginRegData = await beginRegResponse.json();

    const publicKey = beginRegData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create and register the credential
    const registrationCredential = await page.evaluate(async (params) => {
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

      // Generate PRF salt in browser context
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));

      const createOptions: CredentialCreationOptions = {
        publicKey: {
          rp: params.publicKeyOptions.rp,
          user: {
            id: fromBase64Url(params.publicKeyOptions.user.id),
            name: params.publicKeyOptions.user.name,
            displayName: params.publicKeyOptions.user.displayName,
          },
          challenge: fromBase64Url(params.publicKeyOptions.challenge),
          pubKeyCredParams: params.publicKeyOptions.pubKeyCredParams,
          authenticatorSelection: params.publicKeyOptions.authenticatorSelection,
          attestation: params.publicKeyOptions.attestation || 'direct',
          extensions: { prf: { eval: { first: prfSalt } } },
        },
      };

      const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;

      return {
        type: credential.type,
        id: credential.id,
        rawId: toBase64Url(new Uint8Array(credential.rawId)),
        response: {
          attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          transports: response.getTransports?.() || ['internal'],
        },
        authenticatorAttachment: credential.authenticatorAttachment || 'platform',
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    }, {
      publicKeyOptions: {
        rp: publicKey.rp,
        user: { id: userIdB64, name: username, displayName: username },
        challenge: challengeB64,
        pubKeyCredParams: publicKey.pubKeyCredParams,
        authenticatorSelection: publicKey.authenticatorSelection,
        attestation: publicKey.attestation,
      },
    });

    // Finish registration
    const finishRegResponse = await apiRequest.post(
      `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-finish`,
      {
        data: {
          challengeId: beginRegData.challengeId,
          displayName: username,
          privateData: null,
          credential: registrationCredential,
        },
      }
    );
    expect(finishRegResponse.status()).toBe(200);

    // Now test GLOBAL login (not tenant-scoped)
    // The backend should discover the tenant from the userHandle

    // Begin global login
    const beginLoginResponse = await apiRequest.post(
      `${BACKEND_URL}/user/login-webauthn-begin`,
      { data: {} }
    );
    expect(beginLoginResponse.status()).toBe(200);
    const beginLoginData = await beginLoginResponse.json();

    // Perform assertion using the same credential
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

      const challengeB64 = params.challenge.$b64u || params.challenge;

      const getOptions: CredentialRequestOptions = {
        publicKey: {
          challenge: fromBase64Url(challengeB64),
          rpId: params.rpId,
          userVerification: 'required',
          // Empty allowCredentials for discoverable credential
        },
      };

      const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;

      return {
        type: credential.type,
        id: credential.id,
        rawId: toBase64Url(new Uint8Array(credential.rawId)),
        response: {
          authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          signature: toBase64Url(new Uint8Array(response.signature)),
          userHandle: response.userHandle ? toBase64Url(new Uint8Array(response.userHandle)) : null,
        },
        authenticatorAttachment: credential.authenticatorAttachment || 'platform',
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    }, {
      challenge: beginLoginData.requestOptions.publicKey.challenge,
      rpId: beginLoginData.requestOptions.publicKey.rpId,
    });

    // Finish global login
    const finishLoginResponse = await apiRequest.post(
      `${BACKEND_URL}/user/login-webauthn-finish`,
      {
        data: {
          challengeId: beginLoginData.challengeId,
          credential: assertionResult,
        },
      }
    );

    expect(finishLoginResponse.status()).toBe(200);
    const finishLoginData = await finishLoginResponse.json();

    // CRITICAL: Verify tenantId is discovered and returned
    expect(finishLoginData.tenantId).toBeDefined();
    expect(finishLoginData.tenantId).toBe(testTenantId);

    // Also verify other response fields
    expect(finishLoginData.uuid).toBeDefined();
    expect(finishLoginData.appToken).toBeDefined();

    await webauthn.cleanup();
  });

  test('should return empty/default tenantId for legacy users (non-tenant)', async ({
    page,
    request: apiRequest,
  }) => {
    // Register a user via the GLOBAL (non-tenant) registration endpoint
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    const username = generateTestUsername();

    // Begin GLOBAL registration
    const beginRegResponse = await apiRequest.post(
      `${BACKEND_URL}/user/register-webauthn-begin`,
      {
        data: { display_name: username },
      }
    );
    expect(beginRegResponse.status()).toBe(200);
    const beginRegData = await beginRegResponse.json();

    const publicKey = beginRegData.createOptions.publicKey;
    const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
    const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

    // Create credential
    const credential = await page.evaluate(async (params) => {
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

      // Generate PRF salt in browser context
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));

      const createOptions: CredentialCreationOptions = {
        publicKey: {
          rp: params.publicKeyOptions.rp,
          user: {
            id: fromBase64Url(params.publicKeyOptions.user.id),
            name: params.publicKeyOptions.user.name,
            displayName: params.publicKeyOptions.user.displayName,
          },
          challenge: fromBase64Url(params.publicKeyOptions.challenge),
          pubKeyCredParams: params.publicKeyOptions.pubKeyCredParams,
          authenticatorSelection: params.publicKeyOptions.authenticatorSelection,
          attestation: params.publicKeyOptions.attestation || 'direct',
          extensions: { prf: { eval: { first: prfSalt } } },
        },
      };

      const cred = await navigator.credentials.create(createOptions) as PublicKeyCredential;
      const response = cred.response as AuthenticatorAttestationResponse;

      return {
        type: cred.type,
        id: cred.id,
        rawId: toBase64Url(new Uint8Array(cred.rawId)),
        response: {
          attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          transports: response.getTransports?.() || ['internal'],
        },
        authenticatorAttachment: cred.authenticatorAttachment || 'platform',
        clientExtensionResults: cred.getClientExtensionResults(),
      };
    }, {
      publicKeyOptions: {
        rp: publicKey.rp,
        user: { id: userIdB64, name: username, displayName: username },
        challenge: challengeB64,
        pubKeyCredParams: publicKey.pubKeyCredParams,
        authenticatorSelection: publicKey.authenticatorSelection,
        attestation: publicKey.attestation,
      },
    });

    // Finish global registration
    const finishRegResponse = await apiRequest.post(
      `${BACKEND_URL}/user/register-webauthn-finish`,
      {
        data: {
          challengeId: beginRegData.challengeId,
          displayName: username,
          privateData: null,
          credential: credential,
        },
      }
    );
    expect(finishRegResponse.status()).toBe(200);

    // Now login
    const beginLoginResponse = await apiRequest.post(
      `${BACKEND_URL}/user/login-webauthn-begin`,
      { data: {} }
    );
    expect(beginLoginResponse.status()).toBe(200);
    const beginLoginData = await beginLoginResponse.json();

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

      const challengeB64 = params.challenge.$b64u || params.challenge;

      const getOptions: CredentialRequestOptions = {
        publicKey: {
          challenge: fromBase64Url(challengeB64),
          rpId: params.rpId,
          userVerification: 'required',
        },
      };

      const cred = await navigator.credentials.get(getOptions) as PublicKeyCredential;
      const response = cred.response as AuthenticatorAssertionResponse;

      return {
        type: cred.type,
        id: cred.id,
        rawId: toBase64Url(new Uint8Array(cred.rawId)),
        response: {
          authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          signature: toBase64Url(new Uint8Array(response.signature)),
          userHandle: response.userHandle ? toBase64Url(new Uint8Array(response.userHandle)) : null,
        },
        authenticatorAttachment: cred.authenticatorAttachment || 'platform',
        clientExtensionResults: cred.getClientExtensionResults(),
      };
    }, {
      challenge: beginLoginData.requestOptions.publicKey.challenge,
      rpId: beginLoginData.requestOptions.publicKey.rpId,
    });

    const finishLoginResponse = await apiRequest.post(
      `${BACKEND_URL}/user/login-webauthn-finish`,
      {
        data: {
          challengeId: beginLoginData.challengeId,
          credential: assertionResult,
        },
      }
    );

    expect(finishLoginResponse.status()).toBe(200);
    const finishLoginData = await finishLoginResponse.json();

    // For legacy users, tenantId should be 'default' or empty
    // The backend returns 'default' for non-tenant users
    expect(finishLoginData.tenantId).toBeDefined();
    expect(finishLoginData.tenantId).toBe('default');

    await webauthn.cleanup();
  });
});
