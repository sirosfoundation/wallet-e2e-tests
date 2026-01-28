/**
 * WebAuthn Multi-Tenancy Tests with CDP Virtual Authenticator
 *
 * @tags @webauthn @multi-tenancy @cdp @automated
 *
 * These tests use Chrome DevTools Protocol (CDP) to create virtual
 * authenticators that can be programmatically controlled and cleaned
 * between tests. This enables fully automated testing without user
 * interaction.
 *
 * Tests verify:
 * 1. Tenant discovery from passkey credential userHandle
 * 2. Cross-tenant redirect (409 with redirect_tenant)
 * 3. Default tenant accepts global logins
 *
 * Prerequisites:
 *   make up  # Start Docker services
 *   npm run test:webauthn
 */

import { test, expect, request } from '@playwright/test';
import { WebAuthnHelper, toBase64Url, fromBase64Url, generateTestUsername } from '../../helpers/webauthn';
import { TenantApiHelper, generateTestTenantId } from '../../helpers/tenant-api';

// Environment URLs
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-test-admin-token-for-testing-purposes-only';

// Extend test with WebAuthn virtual authenticator fixture
const webauthnTest = test.extend<{
  webauthn: WebAuthnHelper;
  tenantApi: TenantApiHelper;
}>({
  webauthn: async ({ page }, use) => {
    const helper = new WebAuthnHelper(page);
    await helper.initialize();
    await helper.addPlatformAuthenticator();
    await helper.injectPrfMock();
    await use(helper);
    await helper.cleanup();
  },
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

// Helper to generate unique test identifiers
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

webauthnTest.describe('WebAuthn Multi-Tenancy with Virtual Authenticator', () => {

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
  });

  webauthnTest.describe('Default Tenant Registration', () => {
    webauthnTest('should register user in default tenant with 25-byte userHandle', async ({
      page,
      webauthn,
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

      // Verify user handle is in new binary format (25 bytes)
      const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
      const userIdBytes = fromBase64Url(userIdB64);
      expect(userIdBytes.length).toBe(25);
      expect(userIdBytes[0]).toBe(0x01); // Version byte
      console.log(`Default tenant userHandle: ${userIdBytes.length} bytes, version: ${userIdBytes[0]}`);

      // Step 2: Create credential via browser WebAuthn API (uses virtual authenticator)
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

      // Verify credential is stored in virtual authenticator
      const credentials = await webauthn.getCredentials();
      expect(credentials.length).toBeGreaterThan(0);
    });
  });

  webauthnTest.describe('Tenant-Scoped Registration', () => {
    let testTenantId: string;

    webauthnTest.beforeAll(async ({ tenantApi }) => {
      testTenantId = generateTestTenantId();
      try {
        await tenantApi.createTenant(testTenantId, `Test Tenant ${testTenantId}`);
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
      webauthn,
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

      // Verify user handle is in binary format (25 bytes)
      const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
      const userIdBytes = fromBase64Url(userIdB64);
      expect(userIdBytes.length).toBe(25);
      expect(userIdBytes[0]).toBe(0x01); // Version byte
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
    let testTenantId: string;
    let registeredUserId: string;
    let registeredCredentialId: string;

    webauthnTest.beforeAll(async ({ tenantApi }) => {
      testTenantId = `redirect-test-${generateTestId()}`;
      try {
        await tenantApi.createTenant(testTenantId, `Redirect Test Tenant ${testTenantId}`);
        console.log(`Created test tenant for redirect tests: ${testTenantId}`);
      } catch (e) {
        console.log(`Tenant creation error: ${e}`);
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

    webauthnTest('should register user in tenant for redirect tests', async ({
      page,
      webauthn,
      request: apiRequest,
    }) => {
      // Clear any previous credentials
      await webauthn.clearCredentials();

      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      const username = `redirect-user-${generateTestId()}`;

      // Begin registration in custom tenant
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
      registeredUserId = finishData.uuid;
      registeredCredentialId = credentialResult.id;

      console.log(`Registered user ${registeredUserId} in tenant ${testTenantId}`);
    });

    webauthnTest('should return 409 with redirect_tenant when tenant user logs in via global endpoint', async ({
      page,
      webauthn,
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
       */
      expect(registeredUserId).toBeDefined();
      expect(registeredCredentialId).toBeDefined();

      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

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
        { challenge: loginChallenge, rpId }
      );

      expect(assertionResult.id).toBeDefined();

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
      expect(errorData.user_id).toBe(registeredUserId);

      console.log(`Got expected 409 redirect to tenant: ${errorData.redirect_tenant}`);
    });

    webauthnTest('should return 409 when tenant user logs in via wrong tenant endpoint', async ({
      page,
      webauthn,
      request: apiRequest,
      tenantApi,
    }) => {
      /**
       * KEY TEST: Cross-tenant redirect
       *
       * When a user registered in tenant X tries to login via tenant Y's
       * endpoint, the backend should return 409 with the correct tenant X.
       */
      expect(registeredUserId).toBeDefined();

      // Create another tenant for cross-tenant test
      const wrongTenantId = `wrong-tenant-${generateTestId()}`;
      await tenantApi.createTenant(wrongTenantId, `Wrong Tenant ${wrongTenantId}`);

      try {
        await page.goto(FRONTEND_URL);
        await page.waitForLoadState('networkidle');

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
          { challenge: loginChallenge, rpId }
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
        expect(loginFinish.status()).toBe(409);

        const errorData = await loginFinish.json();
        expect(errorData.redirect_tenant).toBe(testTenantId); // Correct tenant
        expect(errorData.redirect_tenant).not.toBe(wrongTenantId); // Not wrong tenant
        expect(errorData.user_id).toBe(registeredUserId);

        console.log(`Got expected 409 redirect from ${wrongTenantId} to ${errorData.redirect_tenant}`);
      } finally {
        // Cleanup wrong tenant
        await tenantApi.deleteTenant(wrongTenantId);
      }
    });
  });

  webauthnTest.describe('Default Tenant Login', () => {
    webauthnTest('should allow default tenant user to login via global endpoint', async ({
      page,
      webauthn,
      request: apiRequest,
    }) => {
      /**
       * KEY TEST: Default tenant accepts global logins
       *
       * Users registered in the "default" tenant should be able to login
       * via the global endpoint successfully (200, not 409).
       */
      // Clear any previous credentials
      await webauthn.clearCredentials();

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
        { challenge: loginChallenge, rpId }
      );

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
