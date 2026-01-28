/**
 * WebAuthn Multi-Tenancy Tests with soft-fido2 Authenticator
 *
 * @tags @webauthn @multi-tenancy @softfido @automated
 *
 * These tests use soft-fido2 as a software FIDO2 authenticator that
 * presents to the browser as a real platform authenticator. This enables
 * testing real WebAuthn flows including PRF extension.
 *
 * Tests verify:
 * 1. Tenant discovery from passkey credential userHandle
 * 2. Cross-tenant redirect (409 with redirect_tenant)
 * 3. Default tenant accepts global logins
 *
 * Prerequisites:
 *   - soft-fido2 installed and running (systemctl start soft-fido2)
 *   - make up  # Start Docker services
 *   - npm run test:tenant-redirect
 */

import { test, expect, request } from '@playwright/test';
import {
  fromBase64Url,
  generateTestUsername,
  generateTestId,
  isSoftFidoAvailable,
  resetSoftFidoCredentials,
} from '../../helpers/softfido';
import { TenantApiHelper, generateTestTenantId } from '../../helpers/tenant-api';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Extend test with tenant API fixture
const webauthnTest = test.extend<{
  tenantApi: TenantApiHelper;
}>({
  tenantApi: async ({}, use) => {
    const apiContext = await request.newContext({
      extraHTTPHeaders: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
    });
    const helper = new TenantApiHelper(apiContext, ADMIN_URL);
    await use(helper);
  },
});

webauthnTest.describe('WebAuthn Multi-Tenancy with soft-fido2', () => {
  webauthnTest.describe('Service Health', () => {
    webauthnTest('should connect to frontend', async ({ page }) => {
      const response = await page.goto(FRONTEND_URL);
      expect(response?.ok()).toBe(true);
    });

    webauthnTest('should connect to backend', async ({ request: apiRequest }) => {
      const response = await apiRequest.get(`${BACKEND_URL}/`);
      // Backend might return 404 for root, just check it responds
      expect(response.status()).toBeLessThan(500);
    });

    webauthnTest('should connect to admin API', async ({ request: apiRequest }) => {
      const response = await apiRequest.get(`${ADMIN_URL}/admin/tenants`, {
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.ok()).toBe(true);
    });

    webauthnTest('should have WebAuthn support available', async ({ page }) => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const webauthnSupported = await page.evaluate(async () => {
        // Check if WebAuthn API is available
        if (typeof PublicKeyCredential === 'undefined') return false;
        // soft-fido2 is a roaming authenticator (USB/HID), not platform
        // so isUserVerifyingPlatformAuthenticatorAvailable() returns false
        // but WebAuthn itself is supported
        return true;
      });

      console.log(`WebAuthn supported: ${webauthnSupported}`);
      expect(webauthnSupported).toBe(true);
    });
  });

  webauthnTest.describe('Default Tenant Registration', () => {
    webauthnTest('should register user in default tenant', async ({
      page,
      request: apiRequest,
    }) => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = generateTestUsername();

      // Step 1: Begin registration
      const beginResponse = await apiRequest.post(`${BACKEND_URL}/user/register-webauthn-begin`, {
        data: { display_name: username },
      });
      expect(beginResponse.ok()).toBe(true);

      const beginData = await beginResponse.json();
      const publicKey = beginData.createOptions.publicKey;

      // User handle format: either 36-byte UUID string or 25-byte binary format
      const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
      const userIdBytes = fromBase64Url(userIdB64);
      // Accept both old format (36 bytes UUID string) and new format (25 bytes binary)
      expect([25, 36]).toContain(userIdBytes.length);
      console.log(`Default tenant userHandle: ${userIdBytes.length} bytes`);

      // Step 2: Create credential via browser WebAuthn API (uses soft-fido2)
      const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;
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
                residentKey: 'required',
                userVerification: 'required',
              },
              timeout: 60000,
            },
          };

          const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
          if (!credential) throw new Error('Failed to create credential');

          const response = credential.response as AuthenticatorAttestationResponse;
          return {
            id: credential.id,
            rawId: toBase64Url(new Uint8Array(credential.rawId)),
            type: credential.type,
            response: {
              clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
              attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
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

      console.log(`Registered default tenant user: ${finishData.uuid}`);
    });
  });

  webauthnTest.describe('Tenant-Scoped Registration', () => {
    let testTenantId: string;

    webauthnTest.beforeAll(async ({ tenantApi }) => {
      testTenantId = generateTestTenantId();
      try {
        await tenantApi.createTenant({
          id: testTenantId,
          name: `Test Tenant ${testTenantId}`,
          enabled: true,
        });
        console.log(`Created test tenant: ${testTenantId}`);
      } catch (e) {
        console.log(`Tenant creation error (may already exist): ${e}`);
      }
    });

    webauthnTest.afterAll(async ({ tenantApi }) => {
      try {
        await tenantApi.deleteTenant(testTenantId);
        console.log(`Deleted test tenant: ${testTenantId}`);
      } catch {
        // Ignore cleanup errors
      }
    });

    webauthnTest('should register user in custom tenant with correct userHandle', async ({
      page,
      request: apiRequest,
    }) => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = generateTestUsername();

      // Step 1: Begin tenant-scoped registration
      const beginResponse = await apiRequest.post(
        `${BACKEND_URL}/t/${testTenantId}/user/register-webauthn-begin`,
        { data: { display_name: username } }
      );
      expect(beginResponse.ok()).toBe(true);

      const beginData = await beginResponse.json();
      const publicKey = beginData.createOptions.publicKey;

      // User handle format: either 36-byte UUID string or 25-byte binary format
      const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
      const userIdBytes = fromBase64Url(userIdB64);
      expect([25, 36]).toContain(userIdBytes.length);
      console.log(`Tenant ${testTenantId} userHandle: ${userIdBytes.length} bytes`);

      // Step 2: Create credential
      const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;
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
                residentKey: 'required',
                userVerification: 'required',
              },
              timeout: 60000,
            },
          };

          const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
          if (!credential) throw new Error('Failed to create credential');

          const response = credential.response as AuthenticatorAttestationResponse;
          return {
            id: credential.id,
            rawId: toBase64Url(new Uint8Array(credential.rawId)),
            type: credential.type,
            response: {
              clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
              attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
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

      console.log(`Registered user ${finishData.uuid} in tenant ${testTenantId}`);
    });
  });

  webauthnTest.describe('Tenant Discovery and Redirect', () => {
    /**
     * These tests verify the 409 redirect behavior when a tenant user
     * tries to login via the wrong endpoint. Each test is self-contained
     * to avoid state sharing issues between tests.
     */

    webauthnTest('should return 409 with redirect_tenant when tenant user logs in via global endpoint', async ({
      page,
      request: apiRequest,
      tenantApi,
    }) => {
      /**
       * KEY TEST: Tenant discovery behavior
       *
       * When a user registered in tenant X tries to login via the global
       * endpoint (no tenant in URL), the backend should:
       * 1. Extract user ID from the userHandle
       * 2. Look up user's tenant membership
       * 3. Return 409 with redirect_tenant field pointing to tenant X
       */
      
      // Create a test tenant
      const testTenantId = `redirect-global-${generateTestId()}`;
      await tenantApi.createTenant({
        id: testTenantId,
        name: `Redirect Global Test ${testTenantId}`,
        enabled: true,
      });
      console.log(`Created test tenant: ${testTenantId}`);

      try {
        await page.goto(FRONTEND_URL);
        await page.waitForLoadState('networkidle');

        const username = `redirect-user-${generateTestId()}`;

        // Step 1: Register user in the custom tenant
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
                pubKeyCredParams: [
                  { type: 'public-key', alg: -7 },
                  { type: 'public-key', alg: -257 },
                ],
                authenticatorSelection: {
                  residentKey: 'required',
                  userVerification: 'required',
                },
                timeout: 60000,
              },
            };

            const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
            if (!credential) throw new Error('Failed to create credential');

            const response = credential.response as AuthenticatorAttestationResponse;
            return {
              id: credential.id,
              rawId: toBase64Url(new Uint8Array(credential.rawId)),
              type: credential.type,
              response: {
                clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
                attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
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
        const registeredUserId = finishData.uuid;
        const registeredCredentialId = credentialResult.id;

        console.log(`Registered user ${registeredUserId} in tenant ${testTenantId}`);

        // Step 2: Try to login via GLOBAL endpoint (should get 409)
        const loginBegin = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-begin`, {
          data: {},
        });
        expect(loginBegin.ok()).toBe(true);

        const loginBeginData = await loginBegin.json();
        const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
        const rpId = loginBeginData.getOptions.publicKey.rpId;

        console.log(`Starting login via global endpoint with credential ${registeredCredentialId}...`);

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
                // Use allowCredentials to specify the exact credential we just registered
                allowCredentials: [{
                  type: 'public-key',
                  id: fromBase64Url(params.credentialId),
                  transports: ['internal', 'usb'],
                }],
              },
            };

            const assertion = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
            if (!assertion) throw new Error('Failed to get assertion');

            const response = assertion.response as AuthenticatorAssertionResponse;
            return {
              id: assertion.id,
              rawId: toBase64Url(new Uint8Array(assertion.rawId)),
              type: assertion.type,
              response: {
                clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
                authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
                signature: toBase64Url(new Uint8Array(response.signature)),
                userHandle: response.userHandle
                  ? { $b64u: toBase64Url(new Uint8Array(response.userHandle)) }
                  : null,
              },
              clientExtensionResults: assertion.getClientExtensionResults(),
              _userHandleLength: response.userHandle?.byteLength,
            };
          },
          { challenge: loginChallenge, rpId, credentialId: registeredCredentialId }
        );

        expect(assertionResult.id).toBeDefined();
        console.log(`Got assertion, userHandle length: ${assertionResult._userHandleLength} bytes`);

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
        console.log(`Login response status: ${loginFinish.status()}`);
        const responseBody = await loginFinish.json();
        console.log(`Login response: ${JSON.stringify(responseBody)}`);

        expect(loginFinish.status()).toBe(409);
        expect(responseBody.error).toBe('Tenant redirect required');
        expect(responseBody.redirect_tenant).toBe(testTenantId);
        expect(responseBody.user_id).toBe(registeredUserId);

        console.log(`Got expected 409 redirect to tenant: ${responseBody.redirect_tenant}`);
      } finally {
        // Cleanup tenant
        await tenantApi.deleteTenant(testTenantId);
        console.log(`Deleted test tenant: ${testTenantId}`);
      }
    });

    webauthnTest('should return 409 when tenant user logs in via wrong tenant endpoint', async ({
      page,
      request: apiRequest,
      tenantApi,
    }) => {
      /**
       * KEY TEST: Cross-tenant redirect
       *
       * When a user registered in tenant X tries to login via tenant Y's
       * endpoint, the backend should return 409 with the correct tenant X.
       */

      // Create the correct tenant where user will be registered
      const correctTenantId = `correct-tenant-${generateTestId()}`;
      await tenantApi.createTenant({
        id: correctTenantId,
        name: `Correct Tenant ${correctTenantId}`,
        enabled: true,
      });

      // Create the wrong tenant where user will try to login
      const wrongTenantId = `wrong-tenant-${generateTestId()}`;
      await tenantApi.createTenant({
        id: wrongTenantId,
        name: `Wrong Tenant ${wrongTenantId}`,
        enabled: true,
      });

      console.log(`Created tenants: correct=${correctTenantId}, wrong=${wrongTenantId}`);

      try {
        await page.goto(FRONTEND_URL);
        await page.waitForLoadState('networkidle');

        const username = `cross-tenant-user-${generateTestId()}`;

        // Step 1: Register user in the CORRECT tenant
        const beginResponse = await apiRequest.post(
          `${BACKEND_URL}/t/${correctTenantId}/user/register-webauthn-begin`,
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
                pubKeyCredParams: [
                  { type: 'public-key', alg: -7 },
                  { type: 'public-key', alg: -257 },
                ],
                authenticatorSelection: {
                  residentKey: 'required',
                  userVerification: 'required',
                },
                timeout: 60000,
              },
            };

            const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
            if (!credential) throw new Error('Failed to create credential');

            const response = credential.response as AuthenticatorAttestationResponse;
            return {
              id: credential.id,
              rawId: toBase64Url(new Uint8Array(credential.rawId)),
              type: credential.type,
              response: {
                clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
                attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
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

        // Finish registration in correct tenant
        const finishResponse = await apiRequest.post(
          `${BACKEND_URL}/t/${correctTenantId}/user/register-webauthn-finish`,
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
        const registeredUserId = finishData.uuid;
        const registeredCredentialId = credentialResult.id;

        console.log(`Registered user ${registeredUserId} in correct tenant ${correctTenantId}`);

        // Step 2: Try to login via WRONG tenant endpoint (should get 409)
        const loginBegin = await apiRequest.post(
          `${BACKEND_URL}/t/${wrongTenantId}/user/login-webauthn-begin`,
          { data: {} }
        );
        expect(loginBegin.ok()).toBe(true);

        const loginBeginData = await loginBegin.json();
        const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
        const rpId = loginBeginData.getOptions.publicKey.rpId;

        console.log(`Starting login via wrong tenant ${wrongTenantId}...`);

        // Get assertion using the correct tenant user's credential
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
                // Use allowCredentials to specify the exact credential
                allowCredentials: [{
                  type: 'public-key',
                  id: fromBase64Url(params.credentialId),
                  transports: ['internal', 'usb'],
                }],
              },
            };

            const assertion = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
            if (!assertion) throw new Error('Failed to get assertion');

            const response = assertion.response as AuthenticatorAssertionResponse;
            return {
              id: assertion.id,
              rawId: toBase64Url(new Uint8Array(assertion.rawId)),
              type: assertion.type,
              response: {
                clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
                authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
                signature: toBase64Url(new Uint8Array(response.signature)),
                userHandle: response.userHandle
                  ? { $b64u: toBase64Url(new Uint8Array(response.userHandle)) }
                  : null,
              },
              clientExtensionResults: assertion.getClientExtensionResults(),
            };
          },
          { challenge: loginChallenge, rpId, credentialId: registeredCredentialId }
        );

        // Finish login via wrong tenant - should get 409
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
        console.log(`Login response status: ${loginFinish.status()}`);
        const responseBody = await loginFinish.json();
        console.log(`Login response: ${JSON.stringify(responseBody)}`);

        expect(loginFinish.status()).toBe(409);
        expect(responseBody.redirect_tenant).toBe(correctTenantId); // Correct tenant
        expect(responseBody.redirect_tenant).not.toBe(wrongTenantId); // Not wrong tenant
        expect(responseBody.user_id).toBe(registeredUserId);

        console.log(`Got expected 409 redirect from ${wrongTenantId} to ${responseBody.redirect_tenant}`);
      } finally {
        // Cleanup both tenants
        await tenantApi.deleteTenant(correctTenantId);
        await tenantApi.deleteTenant(wrongTenantId);
        console.log(`Deleted tenants: ${correctTenantId}, ${wrongTenantId}`);
      }
    });
  });

  webauthnTest.describe('Default Tenant Login', () => {
    webauthnTest('should allow default tenant user to login via global endpoint', async ({
      page,
      request: apiRequest,
    }) => {
      /**
       * KEY TEST: Default tenant accepts global logins
       *
       * Users registered in the "default" tenant should be able to login
       * via the global endpoint successfully (200, not 409).
       */
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

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
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
              ],
              authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
              },
              timeout: 60000,
            },
          };

          const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
          if (!credential) throw new Error('Failed to create credential');

          const response = credential.response as AuthenticatorAttestationResponse;
          return {
            id: credential.id,
            rawId: toBase64Url(new Uint8Array(credential.rawId)),
            type: credential.type,
            response: {
              clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
              attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
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
      const registeredCredentialId = credentialResult.id;

      console.log(`Registered user ${registeredUserId} with credential ${registeredCredentialId}`);

      // Now login via global endpoint
      const loginBegin = await apiRequest.post(`${BACKEND_URL}/user/login-webauthn-begin`, {
        data: {},
      });
      expect(loginBegin.ok()).toBe(true);

      const loginBeginData = await loginBegin.json();
      const loginChallenge = loginBeginData.getOptions.publicKey.challenge.$b64u;
      const rpId = loginBeginData.getOptions.publicKey.rpId;

      console.log(`Starting login assertion for user ${registeredUserId}...`);

      // Get assertion - use allowCredentials to specify the exact credential
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
              // Use allowCredentials to specify the exact credential we just registered
              allowCredentials: [{
                type: 'public-key',
                id: fromBase64Url(params.credentialId),
                transports: ['internal', 'usb'],
              }],
            },
          };

          const assertion = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
          if (!assertion) throw new Error('Failed to get assertion');

          const response = assertion.response as AuthenticatorAssertionResponse;
          return {
            id: assertion.id,
            rawId: toBase64Url(new Uint8Array(assertion.rawId)),
            type: assertion.type,
            response: {
              clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
              authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
              signature: toBase64Url(new Uint8Array(response.signature)),
              userHandle: response.userHandle
                ? { $b64u: toBase64Url(new Uint8Array(response.userHandle)) }
                : null,
            },
            clientExtensionResults: assertion.getClientExtensionResults(),
          };
        },
        { challenge: loginChallenge, rpId, credentialId: registeredCredentialId }
      );

      console.log(`Got assertion for credential ${assertionResult.id}`);

      // Finish login - should succeed for default tenant user
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

      // Should return 200 OK for default tenant user
      expect(loginFinish.ok()).toBe(true);

      const loginData = await loginFinish.json();
      expect(loginData.uuid).toBe(registeredUserId);
      expect(loginData.appToken).toBeDefined();

      console.log(`Default tenant user ${registeredUserId} logged in successfully via global endpoint`);
    });
  });
});
